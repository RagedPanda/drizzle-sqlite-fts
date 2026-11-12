import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {findConfigFile, migrationFiles, parseConfig, schemaFiles} from '../src/cli/project.ts';
import {temporaryProject} from './helpers.ts';

test('findConfigFile finds drizzle.config.* or the requested file', t => {
	const folder = temporaryProject(t, {'drizzle.config.mjs': '', 'db/other.config.ts': ''});
	assert.equal(findConfigFile(folder, undefined), path.join(folder, 'drizzle.config.mjs'));
	assert.equal(findConfigFile(folder, 'db/other.config.ts'), path.join(folder, 'db/other.config.ts'));
	assert.throws(() => findConfigFile(folder, 'missing.ts'), /No drizzle config found: looked for missing.ts in /);
	assert.throws(() => findConfigFile(temporaryProject(t), undefined), /looked for drizzle.config.ts, drizzle.config.mts/);
});

test('parseConfig reads the default export or the module itself', () => {
	assert.deepEqual(parseConfig({default: {dialect: 'sqlite', schema: './schema.ts'}}), {schema: ['./schema.ts'], out: 'drizzle'});
	assert.deepEqual(parseConfig({dialect: 'turso', schema: ['a.ts', 'b/*.ts'], out: './migrations', casing: 'snake_case'}), {
		schema: ['a.ts', 'b/*.ts'], out: './migrations', casing: 'snake_case',
	});
	assert.deepEqual(parseConfig({dialect: 'd1-http', schema: 'a.ts', casing: 'camelCase'}).casing, 'camelCase');
});

test('parseConfig rejects configs it cannot use', () => {
	assert.throws(() => parseConfig({default: {dialect: 'postgresql', schema: 'a.ts'}}), /supports the 'sqlite', 'turso', 'd1-http' dialects only, got "postgresql"/);
	assert.throws(() => parseConfig(undefined), /got undefined/);
	assert.throws(() => parseConfig({dialect: 'sqlite'}), /needs a schema/);
	assert.throws(() => parseConfig({dialect: 'sqlite', schema: []}), /needs a schema/);
	assert.throws(() => parseConfig({dialect: 'sqlite', schema: 'a.ts', casing: 'kebab'}), /Unsupported casing "kebab"/);
});

test('schemaFiles expands files, folders and globs, without declaration files', t => {
	const folder = temporaryProject(t, {
		'src/db/schema.ts': '',
		'src/db/tables/users.ts': '',
		'src/db/tables/users.d.ts': '',
		'src/db/tables/posts.mjs': '',
		'src/other.ts': '',
		'notes.md': '',
	});
	const relative = (files: string[]) => files.map(file => path.relative(folder, file).split(path.sep).join('/'));
	assert.deepEqual(relative(schemaFiles(folder, ['./src/db'])), ['src/db/schema.ts', 'src/db/tables/posts.mjs', 'src/db/tables/users.ts']);
	assert.deepEqual(relative(schemaFiles(folder, ['src/**/users.*', './src/other.ts', 'src/other.ts'])), ['src/db/tables/users.ts', 'src/other.ts']);
	assert.deepEqual(schemaFiles(folder, ['missing.ts']), []);
});

test('migrationFiles follows the journal of Drizzle Kit 0.x', t => {
	const folder = temporaryProject(t, {
		'drizzle/meta/_journal.json': JSON.stringify({entries: [{tag: '0000_init'}, {tag: '0001_fts'}]}),
	});
	assert.deepEqual(migrationFiles(path.join(folder, 'drizzle')), [path.join(folder, 'drizzle/0000_init.sql'), path.join(folder, 'drizzle/0001_fts.sql')]);
});

test('migrationFiles sorts the folders of Drizzle Kit 1.0 by name', t => {
	const folder = temporaryProject(t, {
		'drizzle/20261030115451_fts/migration.sql': '',
		'drizzle/20261030115450_init/migration.sql': '',
		'drizzle/20261030115450_init/snapshot.json': '',
		'drizzle/notes/readme.md': '',
	});
	assert.deepEqual(migrationFiles(path.join(folder, 'drizzle')), [
		path.join(folder, 'drizzle/20261030115450_init/migration.sql'),
		path.join(folder, 'drizzle/20261030115451_fts/migration.sql'),
	]);
	assert.deepEqual(migrationFiles(path.join(folder, 'missing')), []);
});
