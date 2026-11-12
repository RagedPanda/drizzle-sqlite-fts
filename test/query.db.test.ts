import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {asc, eq} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {getFts5Definition} from '../src/declare.ts';
import {bm25, fts5, highlight, match, rawMatch, snippet} from '../src/index.ts';
import {createSql} from '../src/render.ts';
import {toIndexSpec} from '../src/spec.ts';
import {notes} from './fixtures.ts';

const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body'], prefix: [2, 3]});
const memo = fts5('memo', {mode: 'contentless', columns: ['text']});

function seeded(rows: readonly {id: number; title: string; body: string | null}[]) {
	const client = new Database(':memory:');
	client.exec('CREATE TABLE notes (id integer PRIMARY KEY, title text NOT NULL, body text, views integer NOT NULL DEFAULT 0)');
	for (const statement of createSql(toIndexSpec(getFts5Definition(notesSearch)!, undefined))) {
		client.exec(statement);
	}

	const db = drizzle({client});
	if (rows.length > 0) {
		db.insert(notes).values([...rows]).run();
	}

	return db;
}

const corpus = [
	{id: 1, title: 'C++ templates', body: 'generic code OR not'},
	{id: 2, title: 'Databases', body: 'a database stores data'},
	{id: 3, title: 'Gardening', body: 'database of plants'},
	{id: 4, title: 'Cooking', body: null},
];

type Db = ReturnType<typeof seeded>;
const ids = (db: Db, where: ReturnType<typeof match>) =>
	db.select({id: notesSearch.rowid}).from(notesSearch).where(where).orderBy(asc(notesSearch.rowid)).all().map(row => row.id);

test('user input with FTS5 syntax searches its words instead of failing', () => {
	const db = seeded(corpus);
	assert.deepEqual(ids(db, match(notesSearch, '"C++" OR')), [1]);
	assert.deepEqual(ids(db, match(notesSearch, 'NEAR(')), []);
	assert.deepEqual(ids(db, match(notesSearch, 'database')), [2, 3]);
	assert.deepEqual(ids(db, match(notesSearch, 'database plants')), [3]);
});

test('empty input matches no rows, even with bm25 and snippet in the select', () => {
	const db = seeded(corpus);
	const rows = db.select({id: notesSearch.rowid, score: bm25(notesSearch), excerpt: snippet(notesSearch, 'body')})
		.from(notesSearch).where(match(notesSearch, '   ')).all();
	assert.deepEqual(rows, []);
});

test('a prefix search matches words starting with the last term only', () => {
	const db = seeded(corpus);
	assert.deepEqual(ids(db, match(notesSearch, 'dat', {prefix: true})), [2, 3]);
	assert.deepEqual(ids(db, match(notesSearch, 'dat')), []);
	assert.deepEqual(ids(db, match(notesSearch, 'gen cod', {prefix: true})), []);
	assert.deepEqual(ids(db, match(notesSearch, 'generic cod', {prefix: true})), [1]);
});

test('a raw query passes FTS5 syntax through', () => {
	const db = seeded(corpus);
	assert.deepEqual(ids(db, rawMatch(notesSearch, 'title: cooking OR title: gardening')), [3, 4]);
});

test('bm25 weights by column key rank a title hit above a body hit', () => {
	const db = seeded([{id: 1, title: 'other', body: 'zebra'}, {id: 2, title: 'zebra', body: 'other'}]);
	const ranked = (weights: Parameters<typeof bm25<typeof notesSearch>>[1]) => db.select({id: notesSearch.rowid}).from(notesSearch)
		.where(match(notesSearch, 'zebra')).orderBy(bm25(notesSearch, weights)).all().map(row => row.id);
	assert.deepEqual(ranked({title: 10}), [2, 1]);
	assert.deepEqual(ranked({body: 10}), [1, 2]);
	const scores = db.select({score: bm25(notesSearch)}).from(notesSearch).where(match(notesSearch, 'zebra')).all();
	assert.ok(scores.every(({score}) => typeof score === 'number' && score < 0));
});

test('highlight wraps matched terms, and snippet keeps to its token count', () => {
	const db = seeded([{id: 1, title: 'Hello world', body: 'one two three four five six seven eight nine ten hello eleven twelve'}]);
	const [row] = db.select({
		title: highlight(notesSearch, 'title', {open: '<b>', close: '</b>'}),
		excerpt: snippet(notesSearch, 'body', {open: '[', close: ']', ellipsis: '...', tokens: 3}),
		plain: snippet(notesSearch, 'body'),
	}).from(notesSearch).where(match(notesSearch, 'hello')).all();
	assert.equal(row?.title, '<b>Hello</b> world');
	assert.equal(row?.excerpt, '...ten [hello] eleven...');
	assert.equal(row?.plain, 'one two three four five six seven eight nine ten hello eleven twelve', 'the 13 tokens fit the default 16');
});

test('a search joins back to its content table with each column typed', () => {
	const db = seeded(corpus);
	const rows = db.select({id: notes.id, title: notes.title, views: notes.views}).from(notesSearch)
		.innerJoin(notes, eq(notes.id, notesSearch.rowid)).where(match(notesSearch, 'database')).orderBy(notesSearch.rank, notesSearch.rowid).all();
	assert.deepEqual(rows.map(row => row.id).sort(), [2, 3]);
	assert.equal(typeof rows[0]?.views, 'number');
});

test('paging by rank, then rowid, returns every row of an equal-rank set exactly once', () => {
	const rows = Array.from({length: 25}, (_, position) => ({id: position + 1, title: 'same', body: 'same'}));
	const db = seeded(rows);
	const page = (offset: number) => db.select({id: notesSearch.rowid}).from(notesSearch).where(match(notesSearch, 'same'))
		.orderBy(notesSearch.rank, notesSearch.rowid).limit(10).offset(offset).all().map(row => row.id);
	const seen = [...page(0), ...page(10), ...page(20)];
	assert.deepEqual(seen, rows.map(row => row.id));
});

test('helpers refuse what FTS5 would reject at run time', () => {
	assert.throws(() => match(notes as never, 'x'), /match\(\) needs an index that fts5\(\) returned/);
	assert.throws(() => bm25(notesSearch, {missing: 2} as never), /bm25\(\): "notes_fts" has no column with the key "missing"/);
	assert.throws(() => bm25(notesSearch, {title: Number.NaN}), /the weight of "title" must be a finite number, got null/);
	assert.throws(() => highlight(memo as never, 'text' as never, {open: '', close: ''}), /highlight\(\) needs the indexed text, which the contentless index "memo" doesn't keep/);
	assert.throws(() => snippet(memo as never, 'text' as never), /snippet\(\) needs the indexed text/);
	for (const tokens of [0, 65, 1.5]) {
		assert.throws(() => snippet(notesSearch, 'body', {tokens}), /tokens must be a whole number from 1 to 64/);
	}
});
