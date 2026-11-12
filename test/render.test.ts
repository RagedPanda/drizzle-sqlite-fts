import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getFts5Definition} from '../src/declare.ts';
import {quoteIdentifier, quoteLiteral} from '../src/identifiers.ts';
import {copyStandaloneSql, createIndexSql, createSql, createTriggersSql, dropIndexSql, joinStatements, rebuildSql} from '../src/render.ts';
import {toIndexSpec, type IndexSpec} from '../src/spec.ts';
import {fts5} from '../src/index.ts';
import {articles, notes} from './fixtures.ts';

const specOf = (index: unknown, casing?: 'snake_case') => toIndexSpec(getFts5Definition(index)!, casing);

test('identifiers and literals are quoted with their quotes doubled', () => {
	assert.equal(quoteIdentifier('select'), '"select"');
	assert.equal(quoteIdentifier('we"ird'), '"we""ird"');
	assert.equal(quoteLiteral('it\'s'), '\'it\'\'s\'');
});

test('an external-content index becomes a spec with database names', () => {
	assert.deepEqual(specOf(fts5('notes_fts', {table: notes, columns: ['title', 'body'], tokenize: 'trigram', prefix: [2], detail: 'none', columnsize: true})), {
		name: 'notes_fts', mode: 'external', columns: ['title', 'body'], content: {table: 'notes', rowid: 'id'}, tokenize: 'trigram', prefix: [2], detail: 'none', columnsize: true,
	});
	assert.deepEqual(specOf(fts5('articles_fts', {table: articles, columns: ['bodyText']}), 'snake_case').columns, ['body_text']);
	assert.deepEqual(specOf(fts5('docs', {mode: 'standalone', columns: ['title']})), {name: 'docs', mode: 'standalone', columns: ['title']});
});

test('create statements carry every option', () => {
	const spec = specOf(fts5('notes_fts', {table: notes, columns: ['title', 'body'], tokenize: 'porter unicode61', prefix: [2, 3], detail: 'column', columnsize: false}));
	assert.equal(createIndexSql(spec), 'CREATE VIRTUAL TABLE IF NOT EXISTS "notes_fts" USING fts5("title", "body", content=\'notes\', content_rowid=\'id\', tokenize=\'porter unicode61\', prefix=\'2 3\', detail=column, columnsize=0);');
	assert.equal(createIndexSql(specOf(fts5('docs', {mode: 'contentless', columns: ['title']}))), 'CREATE VIRTUAL TABLE IF NOT EXISTS "docs" USING fts5("title", content=\'\');');
	assert.equal(createIndexSql(specOf(fts5('docs', {mode: 'standalone', columns: ['title'], columnsize: true}))), 'CREATE VIRTUAL TABLE IF NOT EXISTS "docs" USING fts5("title");');
});

test('the update trigger watches the indexed columns and the rowid column', () => {
	const [, , update] = createTriggersSql(specOf(fts5('notes_fts', {table: notes, columns: ['title']})));
	assert.equal(update, [
		'CREATE TRIGGER IF NOT EXISTS "notes_fts_au" AFTER UPDATE OF "id", "title" ON "notes" BEGIN',
		'\tINSERT INTO "notes_fts"("notes_fts", rowid, "title") VALUES (\'delete\', old."id", old."title");',
		'\tINSERT INTO "notes_fts"(rowid, "title") VALUES (new."id", new."title");',
		'END;',
	].join('\n'));
});

test('detached indexes get no triggers and no rebuild', () => {
	const spec = specOf(fts5('docs', {mode: 'standalone', columns: ['title']}));
	assert.deepEqual(createTriggersSql(spec), []);
	assert.deepEqual(createSql(spec), [createIndexSql(spec)]);
	assert.deepEqual(dropIndexSql(spec), ['DROP TABLE IF EXISTS "docs";']);
});

test('dropping an external-content index drops its triggers first', () => {
	assert.deepEqual(dropIndexSql(specOf(fts5('notes_fts', {table: notes, columns: ['title']}))), [
		'DROP TRIGGER IF EXISTS "notes_fts_ai";',
		'DROP TRIGGER IF EXISTS "notes_fts_au";',
		'DROP TRIGGER IF EXISTS "notes_fts_ad";',
		'DROP TABLE IF EXISTS "notes_fts";',
	]);
});

test('rendering is deterministic and statements join with drizzle-kit breakpoints', () => {
	const render = () => joinStatements(createSql(specOf(fts5('notes_fts', {table: notes, columns: ['title', 'body']}))));
	assert.equal(render(), render());
	assert.equal(joinStatements(['a;', 'b;']), 'a;\n--> statement-breakpoint\nb;');
	assert.equal(rebuildSql({name: 'x"y', mode: 'external', columns: []}), 'INSERT INTO "x""y"("x""y") VALUES (\'rebuild\');');
});

test('a standalone copy moves only the columns both versions share', () => {
	const previous: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['title', 'old']};
	const next: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['title', 'body'], tokenize: 'trigram'};
	assert.deepEqual(copyStandaloneSql(previous, next), [
		'ALTER TABLE "docs" RENAME TO "__old_docs";',
		createIndexSql(next),
		'INSERT INTO "docs"(rowid, "title") SELECT rowid, "title" FROM "__old_docs";',
		'DROP TABLE "__old_docs";',
	]);
});

test('a standalone copy matches column names case-insensitively, and only standalone indexes copy', () => {
	const previous: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['Title']};
	const next: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['title']};
	assert.equal(copyStandaloneSql(previous, next)[2], 'INSERT INTO "docs"(rowid, "title") SELECT rowid, "Title" FROM "__old_docs";');
	assert.throws(() => copyStandaloneSql({...previous, mode: 'contentless'}, next), /Only a standalone index keeps its rows to copy, but "docs" is contentless/);
});
