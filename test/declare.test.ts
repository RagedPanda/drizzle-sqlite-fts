import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {asc} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {customType, integer, primaryKey, sqliteTable, text, unique, uniqueIndex} from 'drizzle-orm/sqlite-core';
import {columnName, effectiveCasing} from '../src/columns.ts';
import {fts5Definition, getFts5Definition, triggerNames, type ExternalContentDefinition} from '../src/declare.ts';
import {fts5} from '../src/index.ts';
import {articles, notes} from './fixtures.ts';

const externalDefinition = (index: unknown): ExternalContentDefinition => {
	const definition = getFts5Definition(index);
	assert.equal(definition?.mode, 'external');
	return definition as ExternalContentDefinition;
};

test('an external-content index records its table, columns and integer key', () => {
	const definition = externalDefinition(fts5('notes_fts', {table: notes, columns: ['title', 'body'], tokenize: 'porter unicode61', prefix: [2, 3], detail: 'column', columnsize: false}));
	assert.equal(definition.name, 'notes_fts');
	assert.equal(definition.table, notes);
	assert.deepEqual(definition.columns.map(({key, column}) => [key, column?.name]), [['title', 'title'], ['body', 'body']]);
	assert.equal(definition.contentRowid, notes.id);
	assert.equal(definition.tokenize, 'porter unicode61');
	assert.deepEqual(definition.prefix, [2, 3]);
	assert.equal(definition.detail, 'column');
	assert.equal(definition.columnsize, false);
});

test('options that are left out are not recorded', () => {
	const definition = externalDefinition(fts5('notes_fts', {table: notes, columns: ['title']}));
	assert.deepEqual(Object.keys(definition).sort(), ['columns', 'contentRowid', 'mode', 'name', 'table']);
});

test('an explicit contentRowid names a unique, not-null integer column', () => {
	const events = sqliteTable('events', {
		code: text('code').primaryKey(),
		seq: integer('seq').notNull().unique(),
		position: integer('position').notNull(),
		order: integer('order').notNull(),
		loose: integer('loose').unique(),
		note: text('note'),
	}, table => [unique().on(table.position), uniqueIndex('events_order').on(table.order)]);
	for (const key of ['seq', 'position', 'order'] as const) {
		assert.equal(externalDefinition(fts5('events_fts', {table: events, columns: ['note'], contentRowid: key})).contentRowid, events[key]);
	}

	for (const key of ['note', 'loose', 'missing'] as const) {
		assert.throws(() => fts5('events_fts', {table: events, columns: ['note'], contentRowid: key as 'note'}), new RegExp(`contentRowid must be the key of a unique, not-null integer column of "events", got "${key}"`));
	}

	const plain = sqliteTable('plain', {id: integer('id').primaryKey(), stamp: integer('stamp').notNull(), note: text('note')});
	assert.throws(() => fts5('plain_fts', {table: plain, columns: ['note'], contentRowid: 'stamp'}), /unique, not-null integer column/);
});

test('an integer primary key declared in the table extras is found', () => {
	const pairs = sqliteTable('keyed', {id: integer('id'), body: text('body')}, table => [primaryKey({columns: [table.id]})]);
	assert.equal(externalDefinition(fts5('keyed_fts', {table: pairs, columns: ['body']})).contentRowid, pairs.id);
});

test('mode "external" can be given explicitly', () => {
	assert.equal(externalDefinition(fts5('notes_fts', {mode: 'external', table: notes, columns: ['title']})).table, notes);
});

test('JSON columns are refused and text-affinity custom types are accepted', () => {
	const varchar = customType<{data: string}>({dataType: () => 'varchar(255)'});
	const bigText = customType<{data: string}>({dataType: () => 'bigint_text'});
	const pages = sqliteTable('pages', {id: integer('id').primaryKey(), meta: text('meta', {mode: 'json'}), slug: varchar('slug'), odd: bigText('odd')});
	assert.equal(externalDefinition(fts5('pages_fts', {table: pages, columns: ['slug']})).columns[0]?.column, pages.slug);
	assert.throws(() => fts5('pages_fts', {table: pages, columns: ['meta']}), /column "meta" of "pages" holds JSON/);
	assert.throws(() => fts5('pages_fts', {table: pages, columns: ['odd']}), /is bigint_text, but FTS5 indexes text columns/);
});

test('a snake_case schema records the database name of a key-named column', () => {
	const definition = externalDefinition(fts5('articles_fts', {table: articles, columns: ['headline', 'bodyText']}));
	const names = definition.columns.map(({column}) => columnName(column!, effectiveCasing('snake_case')));
	assert.deepEqual(names, ['headline', 'body_text']);
});

test('a table without a single integer primary key is refused, naming the table and the fix', () => {
	const withTextKey = sqliteTable('slugs', {slug: text('slug').primaryKey(), body: text('body')});
	assert.throws(() => fts5('slugs_fts', {table: withTextKey, columns: ['body']}), /needs a stable integer key for "slugs".*contentRowid/);
	const withoutKey = sqliteTable('logs', {line: text('line')});
	assert.throws(() => fts5('logs_fts', {table: withoutKey, columns: ['line']}), /"logs", which has no integer primary key/);
	const withCompositeKey = sqliteTable('pairs', {left: integer('left'), right: integer('right'), body: text('body')}, table => [primaryKey({columns: [table.left, table.right]})]);
	assert.throws(() => fts5('pairs_fts', {table: withCompositeKey, columns: ['body']}), /"pairs", which has no integer primary key/);
});

test('names FTS5 reserves are refused', () => {
	const ranked = sqliteTable('ranked', {id: integer('id').primaryKey(), ranking: text('rank'), rank: text('position')});
	assert.throws(() => fts5('ranked_fts', {table: ranked, columns: ['ranking']}), /can't index a column named "rank"/);
	assert.throws(() => fts5('ranked_fts', {table: ranked, columns: ['rank']}), /can't index a column with the key "rank", because the handle uses it/);
	const renamed = sqliteTable('renamed', {id: integer('id').primaryKey(), position: text('RowId'), rowid: text('row_id'), rowId: text('row_key')});
	assert.throws(() => fts5('renamed_fts', {table: renamed, columns: ['position']}), /can't index a column named "RowId"/);
	assert.throws(() => fts5('renamed_fts', {table: renamed, columns: ['rowid']}), /can't index a column with the key "rowid", because the handle uses it/);
	assert.equal(externalDefinition(fts5('renamed_fts', {table: renamed, columns: ['rowId']})).columns[0]?.key, 'rowId');
	assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['title', 'DOCS']}), /can't index a column named "DOCS"/);
	assert.throws(() => fts5('notes', {table: notes, columns: ['title']}), /can't have the same name as the table it indexes; name it "notes_fts"/);
});

test('invalid columns are refused', () => {
	assert.throws(() => fts5('notes_fts', {table: notes, columns: []}), /needs at least one column/);
	assert.throws(() => fts5('notes_fts', {table: notes, columns: ['missing' as 'title']}), /table "notes" has no column with the key "missing"/);
	assert.throws(() => fts5('notes_fts', {table: notes, columns: ['views']}), /column "views" of "notes" is integer, but FTS5 indexes text columns/);
	assert.throws(() => fts5('notes_fts', {table: notes, columns: ['title', 'title']}), /lists the column "title" twice/);
	assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['Title', 'title']}), /lists the column "title" twice/);
	assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['']}), /column must be a non-empty string/);
});

test('invalid options are refused', () => {
	assert.throws(() => fts5('', {table: notes, columns: ['title']}), /index name must be a non-empty string/);
	assert.throws(() => fts5('notes_fts', undefined as never), /needs an options object/);
	assert.throws(() => fts5('notes_fts', {table: {} as typeof notes, columns: ['title']}), /needs a Drizzle sqliteTable as its table/);
	assert.throws(() => fts5('docs', {mode: 'other' as 'standalone', columns: ['title']}), /mode must be "contentless" or "standalone"/);
	assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['title'], tokenize: ' '}), /tokenize must be a non-empty string/);
	assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['title'], detail: 'bogus' as 'full'}), /detail must be "full", "column" or "none", got "bogus"/);
	assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['title'], columnsize: 0 as unknown as boolean}), /columnsize must be true or false, got 0/);
	for (const prefix of [[], 5]) {
		assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['title'], prefix: prefix as number[]}), /prefix must be a non-empty array of lengths/);
	}

	for (const length of [0, 1000, 1.5]) {
		assert.throws(() => fts5('docs', {mode: 'standalone', columns: ['title'], prefix: [length]}), /prefix lengths must be integers from 1 to 999/);
	}
});

test('detached indexes record their column names', () => {
	for (const mode of ['contentless', 'standalone'] as const) {
		const definition = getFts5Definition(fts5('docs', {mode, columns: ['title', 'body'], prefix: [1, 999]}));
		assert.deepEqual(definition, {name: 'docs', mode, prefix: [1, 999], columns: [{key: 'title', column: undefined}, {key: 'body', column: undefined}]});
	}
});

test('trigger names come from the index name, so two indexes on one table never share one', () => {
	assert.deepEqual(triggerNames('notes_fts'), {insert: 'notes_fts_ai', update: 'notes_fts_au', delete: 'notes_fts_ad'});
	const first = Object.values(triggerNames('notes_fts'));
	const second = Object.values(triggerNames('notes_title_fts'));
	assert.equal(new Set([...first, ...second]).size, 6);
});

test('only values fts5() returned carry a definition', () => {
	assert.equal(getFts5Definition(notes), undefined);
	assert.equal(getFts5Definition(undefined), undefined);
	assert.equal(getFts5Definition('notes_fts'), undefined);
	const index = fts5('notes_fts', {table: notes, columns: ['title']});
	assert.equal(index[fts5Definition].name, 'notes_fts');
	assert.equal(Object.getOwnPropertySymbols(index).includes(fts5Definition), true);
	assert.equal(Object.keys(index).length, Object.keys(fts5('notes_fts', {table: notes, columns: ['title']})).length);
});

test('the handle selects from the FTS5 table with the content columns\' database names', () => {
	const client = new Database(':memory:');
	client.exec('CREATE VIRTUAL TABLE articles_fts USING fts5(headline, body_text)');
	client.exec('INSERT INTO articles_fts (rowid, headline, body_text) VALUES (3, \'Hello\', \'world\')');
	client.exec('CREATE VIRTUAL TABLE docs USING fts5(title)');
	client.exec('INSERT INTO docs (rowid, title) VALUES (7, \'hello\')');
	// drizzle-orm 1.0 takes the casing from the table builder and no longer types the option, so it is cast away there.
	const db = drizzle({client, casing: 'snake_case'} as {client: Database.Database});
	const articlesSearch = fts5('articles_fts', {table: articles, columns: ['headline', 'bodyText']});
	assert.deepEqual(db.select({id: articlesSearch.rowid, headline: articlesSearch.headline, bodyText: articlesSearch.bodyText}).from(articlesSearch).all(), [{id: 3, headline: 'Hello', bodyText: 'world'}]);
	const docs = fts5('docs', {mode: 'standalone', columns: ['title']});
	assert.deepEqual(db.select().from(docs).orderBy(asc(docs.rank)).all(), [{title: 'hello', rowid: 7, rank: null}]);
});
