import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {fts5, type AnyFts5Index, type Fts5Mode} from '../src/index.ts';
import {fts5Definition} from '../src/declare.ts';
import {notes} from './fixtures.ts';

// These checks run when `npm run typecheck` compiles this file; the test only makes sure it loads.
type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends (<T>() => T extends TRight ? 1 : 2) ? true : false;
const expectType = <TCheck extends true>(): TCheck | undefined => undefined;

const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body']});
const docs = fts5('docs', {mode: 'contentless', columns: ['title']});

// @ts-expect-error: notes has no column with the key "missing".
const declareMissing = () => fts5('notes_missing_fts', {table: notes, columns: ['missing']});

// The mode is carried in the handle's type.
expectType<Equal<(typeof notesSearch)[typeof fts5Definition]['mode'], 'external'>>();
expectType<Equal<(typeof docs)[typeof fts5Definition]['mode'], 'contentless'>>();
const modes: Fts5Mode[] = ['external', 'contentless', 'standalone'];

// Indexes of every mode fit in one list.
const indexes: AnyFts5Index[] = [notesSearch, docs];

const selectRows = () => {
	const db = drizzle({client: new Database(':memory:')});
	return db.select({title: notesSearch.title, body: notesSearch.body, rowid: notesSearch.rowid, rank: notesSearch.rank}).from(notesSearch);
};
type Row = Awaited<ReturnType<ReturnType<typeof selectRows>['all']>>[number];
// A not-null content column selects as a string; a nullable one may be null.
expectType<Equal<Row, {title: string; body: string | null; rowid: number; rank: number | null}>>();

test('the type checks in this file compile', () => {
	assert.equal(indexes.length, 2);
	assert.equal(modes.length, 3);
	assert.equal(typeof selectRows, 'function');
	assert.throws(declareMissing, /no column with the key "missing"/);
});
