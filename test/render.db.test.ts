import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {getFts5Definition} from '../src/declare.ts';
import {copyStandaloneSql, createSql, dropIndexSql} from '../src/render.ts';
import {toIndexSpec, type IndexSpec} from '../src/spec.ts';
import {fts5} from '../src/index.ts';
import {assertIntact, migrate, search} from './database.ts';

const notesTable = 'CREATE TABLE notes (id integer PRIMARY KEY, title text NOT NULL, body text, views integer NOT NULL DEFAULT 0)';
const notes = sqliteTable('notes', {id: integer('id').primaryKey(), title: text('title').notNull(), body: text('body'), views: integer('views').notNull().default(0)});
const notesSpec = toIndexSpec(getFts5Definition(fts5('notes_fts', {table: notes, columns: ['title', 'body']}))!, undefined);

function seededNotes() {
	const client = new Database(':memory:');
	client.exec(notesTable);
	client.exec('INSERT INTO notes (id, title, body) VALUES (1, \'apple pie\', \'sweet crust\'), (2, \'banana bread\', \'moist loaf\'), (3, \'cherry tart\', \'sour filling\')');
	return client;
}

test('a new index fills from existing rows and follows every insert, update and delete', () => {
	const client = seededNotes();
	migrate(client, createSql(notesSpec));
	assert.deepEqual(search(client, 'notes_fts', 'moist'), [2]);
	client.exec('UPDATE notes SET body = \'zebra\' WHERE id = 1');
	assert.deepEqual(search(client, 'notes_fts', 'zebra'), [1]);
	assert.deepEqual(search(client, 'notes_fts', 'crust'), []);
	client.exec('INSERT INTO notes (id, title, body) VALUES (4, \'zebra cake\', NULL)');
	assert.deepEqual(search(client, 'notes_fts', 'zebra'), [1, 4]);
	client.exec('DELETE FROM notes WHERE id = 1');
	assert.deepEqual(search(client, 'notes_fts', 'zebra'), [4]);
	client.exec('UPDATE notes SET id = 9 WHERE id = 4');
	assert.deepEqual(search(client, 'notes_fts', 'zebra'), [9]);
	assertIntact(client, 'notes_fts');
});

test('an update of a column the index does not hold leaves the index alone', () => {
	const client = seededNotes();
	migrate(client, createSql(notesSpec));
	const changes = () => (client.prepare('SELECT total_changes() AS count').get() as {count: number}).count;
	const before = changes();
	client.exec('UPDATE notes SET views = views + 1 WHERE id = 2');
	assert.equal(changes() - before, 1);
	assertIntact(client, 'notes_fts');
});

test('dropping an index removes it and its triggers, and running it twice is harmless', () => {
	const client = seededNotes();
	migrate(client, createSql(notesSpec));
	migrate(client, createSql(notesSpec).slice(0, 4));
	migrate(client, dropIndexSql(notesSpec));
	migrate(client, dropIndexSql(notesSpec));
	const left = client.prepare('SELECT name FROM sqlite_master WHERE name LIKE \'notes_fts%\'').all();
	assert.deepEqual(left, []);
	client.exec('INSERT INTO notes (id, title) VALUES (5, \'plain\')');
});

test('a standalone tokenizer change keeps every row searchable under the new tokenizer', () => {
	const client = new Database(':memory:');
	const previous: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['title']};
	const next: IndexSpec = {...previous, tokenize: 'trigram'};
	migrate(client, createSql(previous));
	client.exec('INSERT INTO docs (rowid, title) VALUES (1, \'searching\'), (2, \'sorting\')');
	migrate(client, copyStandaloneSql(previous, next));
	assert.deepEqual(search(client, 'docs', 'arch'), [1]);
	assert.deepEqual(search(client, 'docs', 'rting'), [2]);
	assertIntact(client, 'docs');
});

test('a standalone copy keeps the text of a column renamed only in letter case', () => {
	const client = new Database(':memory:');
	const previous: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['Title']};
	const next: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['title'], tokenize: 'porter'};
	migrate(client, createSql(previous));
	client.exec('INSERT INTO docs (rowid, Title) VALUES (1, \'searching\')');
	migrate(client, copyStandaloneSql(previous, next));
	assert.deepEqual(search(client, 'docs', 'search'), [1]);
	assertIntact(client, 'docs');
});

test('identifiers with quotes and reserved words work end to end', () => {
	const client = new Database(':memory:');
	client.exec('CREATE TABLE "order" ("key" integer PRIMARY KEY, "select" text, "we""ird" text)');
	client.exec('INSERT INTO "order" VALUES (1, \'alpha\', \'beta\')');
	const spec: IndexSpec = {name: 'order "fts"', mode: 'external', columns: ['select', 'we"ird'], content: {table: 'order', rowid: 'key'}};
	migrate(client, createSql(spec));
	assert.deepEqual(search(client, 'order ""fts""', 'beta'), [1]);
	client.exec('UPDATE "order" SET "we""ird" = \'gamma\'');
	assert.deepEqual(search(client, 'order ""fts""', 'gamma'), [1]);
	assertIntact(client, 'order ""fts""');
	migrate(client, dropIndexSql(spec));
});
