import * as sqliteCore from 'drizzle-orm/sqlite-core';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';

// Drizzle 1.0 snake-cases key-named columns in the table builder; before 1.0 the `casing` option does it.
// The tests use whichever the installed version has, so the same database tables fit both.
const snakeCase = (sqliteCore as {snakeCase?: {table: typeof sqliteTable}}).snakeCase;

/** `sqliteTable`, snake-casing key-named columns on Drizzle 1.0. */
export const snakeTable: typeof sqliteTable = snakeCase?.table ?? sqliteTable;

export const notes = sqliteTable('notes', {
	id: integer('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body'),
	views: integer('views').notNull().default(0),
});

export const articles = snakeTable('articles', {
	id: integer().primaryKey(),
	headline: text().notNull(),
	bodyText: text(),
});
