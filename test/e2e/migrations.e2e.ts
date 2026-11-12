import assert from 'node:assert/strict';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {setTimeout} from 'node:timers/promises';
import {createClient} from '@libsql/client';
import Database from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {migrate} from 'drizzle-orm/better-sqlite3/migrator';
import {drizzle as drizzleLibsql} from 'drizzle-orm/libsql';
import {migrate as migrateLibsql} from 'drizzle-orm/libsql/migrator';
import {nodeEnvironment} from '../../src/cli/environment.ts';
import {runCli} from '../../src/cli/run.ts';
import {migrationFiles} from '../../src/cli/project.ts';
import {assertIntact, runMigration, search} from '../database.ts';
import {sourceIndex, temporaryProject} from '../helpers.ts';

function config(extra = ''): string {
	return `import {defineConfig} from 'drizzle-kit';
import {ftsTablesFilter} from ${JSON.stringify(sourceIndex)};
import {notesSearch} from './db/search';
export default defineConfig({dialect: 'sqlite', schema: './db', out: './drizzle'${extra}, tablesFilter: ftsTablesFilter(notesSearch)});
`;
}

function tables(views: string): string {
	return `import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
export const notes = sqliteTable('notes', {id: integer().primaryKey(), title: text().notNull(), body: text(), views: ${views}});
`;
}

const searchFile = (tablesModule: string) => `import {fts5} from ${JSON.stringify(sourceIndex)};
import {notes} from './${tablesModule}';
export const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body']});
`;

test('generate, check and migrate a real project with drizzle-kit, through a table rebuild', {timeout: 120_000}, async t => {
	const cwd = temporaryProject(t, {
		'drizzle.config.ts': config(),
		// A project's own tsconfig, so drizzle-kit does not pick up the target of this repository's.
		'tsconfig.json': JSON.stringify({compilerOptions: {target: 'es2022', module: 'esnext', moduleResolution: 'bundler'}}),
		'db/tables.ts': tables('integer()'),
		'db/search.ts': searchFile('tables'),
	});
	const output: string[] = [];
	const environment = {...nodeEnvironment(cwd), print: (text: string) => output.push(text), printError: (text: string) => output.push(text)};
	const outFolder = path.join(cwd, 'drizzle');

	assert.equal(environment.runDrizzleKit(['generate', '--config=drizzle.config.ts']), 0);
	assert.equal(await runCli(['check'], environment), 1);
	assert.equal(await runCli(['generate', '--name=search'], environment), 0);
	assert.equal(await runCli(['check'], environment), 0);

	// Our exports must not confuse drizzle-kit: it sees no schema changes.
	assert.equal(environment.runDrizzleKit(['generate', '--config=drizzle.config.ts']), 0);
	assert.equal(migrationFiles(outFolder).length, 2);

	const client = new Database(':memory:');
	t.after(() => client.close());
	const db = drizzle({client});
	migrate(db, {migrationsFolder: outFolder});
	client.prepare('INSERT INTO notes (id, title, body, views) VALUES (1, \'Postgres tuning\', \'vacuum\', 1), (2, \'SQLite search\', \'fts5 tokenizers\', 1)').run();
	assert.deepEqual(search(client, 'notes_fts', 'search'), [2]);

	// A NOT NULL change makes drizzle-kit rebuild the table, which drops its triggers with it.
	// New files, because jiti caches modules for the life of the process, which is one run of the real CLI.
	rmSync(path.join(cwd, 'db/tables.ts'));
	rmSync(path.join(cwd, 'db/search.ts'));
	writeFileSync(path.join(cwd, 'db/notes.ts'), tables('integer().notNull().default(0)'));
	writeFileSync(path.join(cwd, 'db/index.ts'), searchFile('notes'));
	writeFileSync(path.join(cwd, 'drizzle.config.ts'), config().replace('./db/search', './db/index'));
	// Drizzle Kit 1.0 names migration folders by the second, so a migration made in the same second as ours could sort before it.
	await setTimeout(1000);
	assert.equal(environment.runDrizzleKit(['generate', '--config=drizzle.config.ts']), 0);
	assert.match(readFileSync(migrationFiles(outFolder)[2]!, 'utf8'), /__new_notes/);
	assert.equal(await runCli(['check'], environment), 1);
	assert.equal(await runCli(['generate', '--name=retrigger'], environment), 0);
	assert.equal(await runCli(['check'], environment), 0);

	migrate(db, {migrationsFolder: outFolder});
	client.prepare('INSERT INTO notes (id, title, body) VALUES (3, \'Search after a rebuild\', NULL)').run();
	client.prepare('UPDATE notes SET body = \'trigram search\' WHERE id = 1').run();
	assert.deepEqual(search(client, 'notes_fts', 'search'), [1, 2, 3]);
	assertIntact(client, 'notes_fts');
	assert.match(output.join('\n'), /Wrote drizzle[\\/].*search[^\n]*:\n {2}- create notes_fts[\s\S]*Wrote drizzle[\\/].*retrigger/);
});

test('drizzle-kit push keeps the index when the config filters it out', {timeout: 120_000}, async t => {
	const cwd = temporaryProject(t, {
		'drizzle.config.ts': config(', dbCredentials: {url: \'file:./local.db\'}'),
		'tsconfig.json': JSON.stringify({compilerOptions: {target: 'es2022', module: 'esnext', moduleResolution: 'bundler'}}),
		'db/tables.ts': tables('integer()'),
		'db/search.ts': searchFile('tables'),
	});
	const environment = {...nodeEnvironment(cwd), print() {}, printError() {}};
	assert.equal(environment.runDrizzleKit(['push', '--config=drizzle.config.ts', '--force']), 0);

	const sqlOutput: string[] = [];
	assert.equal(await runCli(['sql'], {...environment, print: text => sqlOutput.push(text)}), 0);
	// Closed in the test rather than in an after hook, which would run after the folder is removed: Windows can't remove an open file.
	const client = new Database(path.join(cwd, 'local.db'));
	try {
		client.exec(sqlOutput.join('\n'));
		client.prepare('INSERT INTO notes (id, title) VALUES (1, \'pushed\')').run();

		// The second push sees only notes, which is unchanged, so it leaves the index and its shadow tables alone.
		assert.equal(environment.runDrizzleKit(['push', '--config=drizzle.config.ts', '--force']), 0);
		assert.deepEqual(search(client, 'notes_fts', 'pushed'), [1]);
		assertIntact(client, 'notes_fts');
	} finally {
		client.close();
	}
});

test('the generated migrations run on libsql and node:sqlite too', {timeout: 120_000}, async t => {
	const cwd = temporaryProject(t, {
		'drizzle.config.ts': config(),
		'tsconfig.json': JSON.stringify({compilerOptions: {target: 'es2022', module: 'esnext', moduleResolution: 'bundler'}}),
		'db/tables.ts': tables('integer()'),
		'db/search.ts': searchFile('tables'),
	});
	const environment = {...nodeEnvironment(cwd), print() {}, printError() {}};
	const outFolder = path.join(cwd, 'drizzle');
	assert.equal(environment.runDrizzleKit(['generate', '--config=drizzle.config.ts']), 0);
	assert.equal(await runCli(['generate'], environment), 0);

	const libsql = createClient({url: ':memory:'});
	t.after(() => libsql.close());
	await migrateLibsql(drizzleLibsql({client: libsql}), {migrationsFolder: outFolder});
	await libsql.execute('INSERT INTO notes (id, title) VALUES (1, \'libsql search\')');
	const found = await libsql.execute('SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH \'libsql\'');
	assert.deepEqual(found.rows.map(row => Number(row['id'])), [1]);

	const nodeSqlite = new DatabaseSync(':memory:');
	t.after(() => nodeSqlite.close());
	for (const file of migrationFiles(outFolder)) {
		runMigration(nodeSqlite, readFileSync(file, 'utf8'));
	}

	nodeSqlite.prepare('INSERT INTO notes (id, title) VALUES (1, \'node search\')').run();
	assert.deepEqual(nodeSqlite.prepare('SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH \'node\'').all().map(row => row['id']), [1]);
});
