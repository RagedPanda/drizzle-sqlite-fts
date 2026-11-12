import type Database from 'better-sqlite3';
import {joinStatements, statementBreakpoint} from '../src/render.ts';

/** Runs statements the way drizzle-kit's migrator does: split on breakpoints, one at a time. */
export function migrate(client: Database.Database, statements: readonly string[]): void {
	runMigration(client, joinStatements(statements));
}

/** Runs a whole migration file the way drizzle-kit's migrator does. */
export function runMigration(client: {exec(sql: string): unknown}, migration: string): void {
	for (const statement of migration.split(statementBreakpoint)) {
		client.exec(statement);
	}
}

export const search = (client: Database.Database, index: string, query: string): number[] =>
	client.prepare(`SELECT rowid AS id FROM "${index}" WHERE "${index}" MATCH ? ORDER BY rowid`).all(query).map(row => (row as {id: number}).id);

/** Throws unless the index matches its content, using FTS5's own integrity check. */
export function assertIntact(client: Database.Database, index: string): void {
	client.prepare(`INSERT INTO "${index}"("${index}", rank) VALUES ('integrity-check', 1)`).run();
}
