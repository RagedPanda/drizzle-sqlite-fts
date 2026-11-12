// Compares ways to search text in SQLite from Drizzle, and measures what keeping an FTS5 index in sync costs on writes.
//
//   npm run bench
//   BENCH_ROWS=20000 BENCH_RUNS=5 npm run bench
//
// Every approach answers the same queries over the same rows. The median of the timed runs is reported.
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import Database from 'better-sqlite3';
import {and, desc, eq, like, or, sql, type SQL} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {defineIndex} from '@siftlite/core';
import {createFts5Engine} from '@siftlite/fts5';
import {nodeSqliteAdapter} from '@siftlite/node';
import MiniSearch from 'minisearch';
import {getFts5Definition} from '../src/declare.ts';
import {bm25, fts5, match} from '../src/index.ts';
import {createSql} from '../src/render.ts';
import {toIndexSpec} from '../src/spec.ts';

const rowCount = Number(process.env['BENCH_ROWS'] ?? 100_000);
const runs = Number(process.env['BENCH_RUNS'] ?? 7);
const warmups = 2;
const queriesPerSet = 50;
const pageSize = 20;

const notes = sqliteTable('notes', {
	id: integer().primaryKey(),
	title: text().notNull(),
	body: text().notNull(),
});
const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body']});

/** The SQL `drizzle-sqlite-fts sql` prints for `notesSearch`: the index, its sync triggers and the backfill. */
const indexSql = createSql(toIndexSpec(getFts5Definition(notesSearch)!, undefined));

/** A small seeded random number generator (mulberry32), so every run searches the same text. */
function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6D_2B_79_F5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const syllables = ['ka', 'lo', 'mi', 'ten', 'ra', 'vo', 'su', 'pel', 'dor', 'an', 'ix', 'ber', 'qua', 'zen', 'tor', 'ely'];

/** 20,000 made-up words, so word frequency follows a Zipf-like curve the way it does in real text. */
const vocabulary = Array.from({length: 20_000}, (_, rank) => {
	let word = '';
	for (let rest = rank + syllables.length; rest > 0; rest = Math.floor(rest / syllables.length)) {
		word += syllables[rest % syllables.length];
	}

	return word;
});

function sentence(next: () => number, words: number): string {
	return Array.from({length: words}, () => vocabulary[Math.floor(vocabulary.length * next() ** 3)]).join(' ');
}

type Note = {id: number; title: string; body: string};

function makeNotes(count: number): Note[] {
	const next = random(42);
	return Array.from({length: count}, (_, index) => ({id: index + 1, title: sentence(next, 6), body: sentence(next, 60)}));
}

/** Query sets: a common word, a rare word, and two common words that must both appear. */
function querySets(): {name: string; queries: string[][]}[] {
	const next = random(7);
	const pick = (from: number, to: number) => vocabulary[from + Math.floor(next() * (to - from))]!;
	return [
		{name: 'common word', queries: Array.from({length: queriesPerSet}, () => [pick(20, 200)])},
		{name: 'rare word', queries: Array.from({length: queriesPerSet}, () => [pick(5000, 15_000)])},
		{name: 'two common words', queries: Array.from({length: queriesPerSet}, () => [pick(20, 200), pick(20, 200)])},
	];
}

function median(values: readonly number[]): number {
	const sorted = values.toSorted((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The median time of `work` over the timed runs, after the warmups. */
async function time(work: () => unknown): Promise<number> {
	const timings = [];
	for (let run = 0; run < warmups + runs; run++) {
		const start = performance.now();
		await work();
		if (run >= warmups) {
			timings.push(performance.now() - start);
		}
	}

	return median(timings);
}

function openDatabase(rows: readonly Note[], withIndex: boolean): Database.Database {
	const client = new Database(':memory:');
	client.exec('CREATE TABLE notes (id integer PRIMARY KEY, title text NOT NULL, body text NOT NULL)');
	if (withIndex) {
		client.exec(indexSql.join(';\n'));
	}

	const insert = client.prepare('INSERT INTO notes (id, title, body) VALUES (@id, @title, @body)');
	client.transaction(() => rows.forEach(row => insert.run(row)))();
	return client;
}

type Approach = {
	readonly name: string;
	readonly search: (words: readonly string[]) => unknown;
};

type Build = {milliseconds: number; heapBytes: number};

/** How long `build` takes, and how much memory what it returns keeps. */
async function measureBuild<T>(build: () => T | Promise<T>): Promise<{result: T} & Build> {
	globalThis.gc?.();
	const heapBefore = process.memoryUsage().heapUsed;
	const start = performance.now();
	const result = await build();
	const milliseconds = performance.now() - start;
	globalThis.gc?.();
	return {result, milliseconds, heapBytes: process.memoryUsage().heapUsed - heapBefore};
}

/** SiftLite keeps its own FTS5 table and triggers next to `notes`, created from a definition at runtime. */
async function siftLiteIndex(client: Database.Database) {
	const definition = defineIndex({
		name: 'notes',
		mode: 'linked',
		source: {table: 'notes', primaryKey: {field: 'id', type: 'safe-integer'}},
		searchable: {title: {weight: 1}, body: {weight: 1}},
	});
	const index = createFts5Engine({adapter: nodeSqliteAdapter(client)}).index(definition);
	await index.create();
	return index;
}

async function searchApproaches(client: Database.Database, rows: readonly Note[]): Promise<{approaches: Approach[]; builds: Record<string, Build>}> {
	const db = drizzle({client});
	const containsWord = (word: string) => or(like(notes.title, `%${word}%`), like(notes.body, `%${word}%`))!;
	const handWritten = client.prepare(`SELECT notes.id, notes.title FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
		WHERE notes_fts MATCH ? ORDER BY bm25(notes_fts) LIMIT ${pageSize}`);

	const siftLite = await measureBuild(() => siftLiteIndex(client));
	const miniSearch = await measureBuild(() => {
		const search = new MiniSearch<Note>({fields: ['title', 'body'], storeFields: ['title']});
		search.addAll(rows);
		return search;
	});

	const approaches: Approach[] = [
		{
			name: 'Drizzle `like()` on both columns, newest first',
			search: words => db.select({id: notes.id, title: notes.title}).from(notes)
				.where(and(...words.map(containsWord) as [SQL, ...SQL[]])).orderBy(desc(notes.id)).limit(pageSize).all(),
		},
		{
			name: '**drizzle-sqlite-fts `match()` + `bm25()`**',
			search: words => db.select({id: notes.id, title: notes.title}).from(notesSearch)
				.innerJoin(notes, eq(notes.id, notesSearch.rowid))
				.where(match(notesSearch, words.join(' '))).orderBy(bm25(notesSearch)).limit(pageSize).all(),
		},
		{
			name: 'drizzle-sqlite-fts `match()`, newest first',
			search: words => db.select({id: notes.id, title: notes.title}).from(notesSearch)
				.innerJoin(notes, eq(notes.id, notesSearch.rowid))
				.where(match(notesSearch, words.join(' '))).orderBy(desc(notesSearch.rowid)).limit(pageSize).all(),
		},
		{
			name: 'Hand-written FTS5 SQL in a Drizzle `sql` template',
			search: words => db.all(sql`SELECT notes.id, notes.title FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
				WHERE notes_fts MATCH ${words.map(word => `"${word}"`).join(' ')} ORDER BY bm25(notes_fts) LIMIT ${pageSize}`),
		},
		{
			name: 'Hand-written FTS5 SQL, prepared once (better-sqlite3, no Drizzle)',
			search: words => handWritten.all(words.map(word => `"${word}"`).join(' ')),
		},
		{
			name: '[SiftLite](https://github.com/aashahin/siftlite) 0.3 `search()`',
			search: words => siftLite.result.search(words.join(' '), {limit: pageSize, hydrate: true}),
		},
		{
			name: 'MiniSearch, in memory',
			search: words => miniSearch.result.search(words.join(' '), {combineWith: 'AND'}).slice(0, pageSize),
		},
	];
	return {approaches, builds: {SiftLite: siftLite, MiniSearch: miniSearch}};
}

/** Checks that the FTS5 approaches agree, so the benchmark compares the same work. */
async function assertSameResults(approaches: readonly Approach[], words: readonly string[]): Promise<void> {
	const [, helpers, , , handWritten, siftLite] = approaches;
	const ids = (rows: unknown) => JSON.stringify((rows as {id: number}[]).map(row => row.id));
	if (ids(helpers!.search(words)) !== ids(handWritten!.search(words))) {
		throw new Error(`The helpers and the hand-written SQL disagree on ${words.join(' ')}`);
	}

	const siftLiteHits = (siftLite!.search(words) as Promise<{hits: unknown[]}>).then(result => result.hits.length);
	const expected = (helpers!.search(words) as unknown[]).length;
	return siftLiteHits.then(count => {
		if (count !== expected) {
			throw new Error(`SiftLite found ${count} rows for ${words.join(' ')}, the helpers ${expected}`);
		}
	});
}

/** What the sync triggers add to inserting, updating and deleting rows. */
function measureWrites(rows: readonly Note[], withIndex: boolean): {insert: number; update: number; remove: number} {
	const client = new Database(':memory:');
	client.exec('CREATE TABLE notes (id integer PRIMARY KEY, title text NOT NULL, body text NOT NULL)');
	if (withIndex) {
		client.exec(indexSql.join(';\n'));
	}

	const insert = client.prepare('INSERT INTO notes (id, title, body) VALUES (@id, @title, @body)');
	const update = client.prepare('UPDATE notes SET body = body || \' edited\' WHERE id <= ?');
	const remove = client.prepare('DELETE FROM notes WHERE id <= ?');
	const changed = Math.floor(rows.length / 10);
	const timed = (work: () => void) => {
		const start = performance.now();
		client.transaction(work)();
		return performance.now() - start;
	};

	const result = {
		insert: timed(() => rows.forEach(row => insert.run(row))),
		update: timed(() => update.run(changed)),
		remove: timed(() => remove.run(changed)),
	};
	client.close();
	return result;
}

const rows = makeNotes(rowCount);
const client = openDatabase(rows, true);
const sqliteVersion = (client.prepare('SELECT sqlite_version() AS version').get() as {version: string}).version;
console.log(`SQLite ${sqliteVersion} (better-sqlite3, in memory), Node.js ${process.version}, ${os.cpus()[0]?.model ?? os.arch()}, ${os.platform()}`);
console.log(`${rowCount.toLocaleString('en')} rows of a 6-word title and a 60-word body; ${queriesPerSet} queries per set, top ${pageSize}; median of ${runs} runs after ${warmups} warmups\n`);

const tableBytes = (database: Database.Database) => (database.prepare('SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS bytes').get() as {bytes: number}).bytes;
const plain = openDatabase(rows, false);
const plainBytes = tableBytes(plain);
plain.close();
const indexBytes = tableBytes(client) - plainBytes;
const {approaches, builds} = await searchApproaches(client, rows);
const sets = querySets();
for (const set of sets) {
	for (const words of set.queries) {
		await assertSameResults(approaches, words);
	}
}

console.log(`| Approach | ${sets.map(set => set.name).join(' | ')} |`);
console.log(`| --- |${' ---: |'.repeat(sets.length)}`);
for (const approach of approaches) {
	const perQuery = [];
	for (const set of sets) {
		perQuery.push(await time(async () => {
			for (const words of set.queries) {
				await approach.search(words);
			}
		}) / set.queries.length);
	}

	console.log(`| ${approach.name} | ${perQuery.map(milliseconds => `${milliseconds.toFixed(3)} ms`).join(' | ')} |`);
}

console.log('');
for (const [name, build] of Object.entries(builds)) {
	console.log(`${name} index build: ${build.milliseconds.toFixed(0)} ms, ${(build.heapBytes / 1024 / 1024).toFixed(0)} MB of JavaScript heap`);
}

console.log(`FTS5 index size: ${(indexBytes / 1024 / 1024).toFixed(0)} MB on top of ${(plainBytes / 1024 / 1024).toFixed(0)} MB of table\n`);
client.close();


const without = measureWrites(rows, false);
const withIndex = measureWrites(rows, true);
const changed = Math.floor(rowCount / 10).toLocaleString('en');
console.log('| Write, one transaction | No index | With the index and its sync triggers |');
console.log('| --- | ---: | ---: |');
console.log(`| Insert ${rowCount.toLocaleString('en')} rows | ${without.insert.toFixed(0)} ms | ${withIndex.insert.toFixed(0)} ms |`);
console.log(`| Update the body of ${changed} rows | ${without.update.toFixed(0)} ms | ${withIndex.update.toFixed(0)} ms |`);
console.log(`| Delete ${changed} rows | ${without.remove.toFixed(0)} ms | ${withIndex.remove.toFixed(0)} ms |`);
