import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {desc, eq, sql} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {getFts5Definition} from '../src/declare.ts';
import {bm25, fts5, ftsTablesFilter, highlight, match, rawMatch, snippet} from '../src/index.ts';
import {createSql} from '../src/render.ts';
import {toIndexSpec} from '../src/spec.ts';

// The schema and queries from the README, so its examples keep working.
const notes = sqliteTable('notes', {
	id: integer('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body'),
});
const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body'], tokenize: 'porter unicode61'});
const docs = fts5('docs', {mode: 'standalone', columns: ['title', 'body']});

function database() {
	const client = new Database(':memory:');
	client.exec('CREATE TABLE notes (id integer PRIMARY KEY, title text NOT NULL, body text)');
	for (const index of [notesSearch, docs]) {
		for (const statement of createSql(toIndexSpec(getFts5Definition(index)!, undefined))) {
			client.exec(statement);
		}
	}

	const db = drizzle({client});
	db.insert(notes).values([
		{id: 1, title: 'SQLite search', body: 'Searching notes with full-text indexes'},
		{id: 2, title: 'Postgres tuning', body: 'Vacuum and searches'},
		{id: 3, title: 'Gardening', body: null},
	]).run();
	return db;
}

test('the README search examples return what it says', t => {
	const db = database();
	t.after(() => db.$client.close());
	const userInput = 'search';
	const results = db
		.select({
			id: notes.id,
			title: highlight(notesSearch, 'title', {open: '<mark>', close: '</mark>'}),
			excerpt: snippet(notesSearch, 'body', {open: '<mark>', close: '</mark>', tokens: 12}),
		})
		.from(notesSearch)
		.innerJoin(notes, eq(notes.id, notesSearch.rowid))
		.where(match(notesSearch, userInput, {prefix: true}))
		.orderBy(bm25(notesSearch, {title: 10, body: 1}), notesSearch.rowid)
		.limit(20)
		.all();
	assert.deepEqual(results, [
		{id: 1, title: 'SQLite <mark>search</mark>', excerpt: '<mark>Searching</mark> notes with full-text indexes'},
		{id: 2, title: 'Postgres tuning', excerpt: 'Vacuum and <mark>searches</mark>'},
	]);

	const newest = db.select({id: notesSearch.rowid}).from(notesSearch)
		.where(match(notesSearch, userInput))
		.orderBy(desc(notesSearch.rowid))
		.limit(20)
		.all();
	assert.deepEqual(newest, [{id: 2}, {id: 1}]);

	assert.deepEqual(db.select({id: notesSearch.rowid}).from(notesSearch).where(rawMatch(notesSearch, 'title: (sqlite OR postgres) NOT vacuum')).all(), [{id: 1}]);
	assert.deepEqual(db.select({id: notesSearch.rowid}).from(notesSearch).where(match(notesSearch, 'C++ OR "x')).all(), []);
});

test('the README standalone insert and push filter work as shown', t => {
	const db = database();
	t.after(() => db.$client.close());
	const [id, title, body] = [7, 'Release notes', 'What changed'];
	db.run(sql`INSERT INTO ${docs} (rowid, title, body) VALUES (${id}, ${title}, ${body})`);
	assert.deepEqual(db.select({id: docs.rowid, title: docs.title}).from(docs).where(match(docs, 'changed')).all(), [{id: 7, title: 'Release notes'}]);
	assert.deepEqual(ftsTablesFilter(notesSearch), ['!notes_fts', '!notes_fts_*']);
});
