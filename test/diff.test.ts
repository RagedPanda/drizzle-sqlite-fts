import assert from 'node:assert/strict';
import {test} from 'node:test';
import Database from 'better-sqlite3';
import {planMigration, type MigrationPlan} from '../src/diff.ts';
import {renderMigration} from '../src/migration.ts';
import {copyStandaloneSql, createSql, createTriggersSql, dropIndexSql, rebuildSql} from '../src/render.ts';
import type {IndexSpec} from '../src/spec.ts';
import {assertIntact, runMigration, search} from './database.ts';

const createNotes = 'CREATE TABLE `notes` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL,\n\t`body` text\n);';
const rebuildNotes = [
	'PRAGMA foreign_keys=OFF;--> statement-breakpoint',
	'CREATE TABLE `__new_notes` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL,\n\t`body` text DEFAULT \'\'\n);',
	'--> statement-breakpoint',
	'INSERT INTO `__new_notes`("id", "title", "body") SELECT "id", "title", "body" FROM `notes`;--> statement-breakpoint',
	'DROP TABLE `notes`;--> statement-breakpoint',
	'ALTER TABLE `__new_notes` RENAME TO `notes`;--> statement-breakpoint',
	'PRAGMA foreign_keys=ON;',
].join('\n');
const notesSpec: IndexSpec = {name: 'notes_fts', mode: 'external', columns: ['title', 'body'], content: {table: 'notes', rowid: 'id'}};
const docsSpec: IndexSpec = {name: 'docs', mode: 'standalone', columns: ['title']};
const memoSpec: IndexSpec = {name: 'memo', mode: 'contentless', columns: ['text']};

/** The migration file a plan becomes. */
const written = (plan: MigrationPlan) => renderMigration(plan.statements, plan.marker);

test('a new index is created, and once its migration exists nothing is left to do', () => {
	const first = planMigration([notesSpec, docsSpec], [createNotes]);
	assert.deepEqual(first.statements, [...createSql(notesSpec), ...createSql(docsSpec)]);
	assert.deepEqual(first.changes, ['create notes_fts', 'create docs']);
	assert.deepEqual(first.marker, {version: 1, set: [notesSpec, docsSpec], created: ['notes_fts', 'docs'], drop: []});
	assert.deepEqual(first.refusals, []);
	assert.deepEqual(planMigration([docsSpec, notesSpec], [createNotes, written(first)]), {statements: [], marker: {version: 1, set: [], created: [], drop: []}, changes: [], refusals: []});
});

test('indexes added on two branches both stay, and the next run has nothing to write', () => {
	const branchA = written(planMigration([notesSpec], [createNotes]));
	const branchB = written(planMigration([docsSpec], [createNotes]));
	assert.deepEqual(planMigration([notesSpec, docsSpec], [createNotes, branchA, branchB]).statements, []);
});

test('an index on a table no earlier migration creates is refused', () => {
	const plan = planMigration([notesSpec], []);
	assert.deepEqual(plan.statements, []);
	assert.deepEqual(plan.marker.set, []);
	assert.deepEqual(plan.refusals, ['"notes_fts" indexes "notes", which no earlier migration creates. Run drizzle-kit generate first, then run this again.']);
	assert.equal(planMigration([notesSpec], [createNotes, 'DROP TABLE `notes`;']).refusals.length, 1);
});

test('a rebuilt content table gets its triggers back and the index refilled', () => {
	const created = written(planMigration([notesSpec], [createNotes]));
	const plan = planMigration([notesSpec], [createNotes, created, rebuildNotes]);
	assert.deepEqual(plan.statements, [...createTriggersSql(notesSpec), rebuildSql(notesSpec)]);
	assert.deepEqual(plan.changes, ['restore the triggers of notes_fts and rebuild it, because a migration rebuilt "notes"']);
	assert.deepEqual(plan.marker.set, [notesSpec]);
	assert.deepEqual(plan.marker.created, [], 'a repair changes an index rather than creating it');
	assert.deepEqual(planMigration([notesSpec], [createNotes, created, rebuildNotes, written(plan)]).statements, []);
});

test('a content table dropped for good is refused rather than repaired', () => {
	const created = written(planMigration([notesSpec], [createNotes]));
	assert.match(planMigration([notesSpec], [createNotes, created, 'DROP TABLE `notes`;']).refusals[0]!, /which no earlier migration creates/);
});

test('a changed external-content index is dropped and created again with a rebuild', () => {
	const created = written(planMigration([notesSpec], [createNotes]));
	const changed = {...notesSpec, tokenize: 'porter unicode61'};
	const plan = planMigration([changed], [createNotes, created]);
	assert.deepEqual(plan.statements, [...dropIndexSql(notesSpec), ...createSql(changed)]);
	assert.deepEqual(plan.changes, ['recreate notes_fts, refilling it from its table']);
	assert.deepEqual(planMigration([changed], [createNotes, created, written(plan)]).statements, []);
});

test('a changed index whose new content table does not exist is refused', () => {
	const created = written(planMigration([notesSpec], [createNotes]));
	const moved = {...notesSpec, content: {table: 'posts', rowid: 'id'}};
	assert.match(planMigration([moved], [createNotes, created]).refusals[0]!, /"notes_fts" indexes "posts"/);
});

test('a changed standalone index is recreated with its rows copied', () => {
	const created = written(planMigration([docsSpec], []));
	const changed = {...docsSpec, tokenize: 'trigram'};
	const plan = planMigration([changed], [created]);
	assert.deepEqual(plan.statements, copyStandaloneSql(docsSpec, changed));
	assert.deepEqual(plan.changes, ['recreate docs, copying its rows']);
});

test('changing a contentless index, or a standalone one into another mode, needs the data-loss flag', () => {
	const created = written(planMigration([memoSpec, docsSpec], []));
	const memoChanged = {...memoSpec, tokenize: 'trigram'};
	const docsContentless: IndexSpec = {...docsSpec, mode: 'contentless'};
	const refused = planMigration([memoChanged, docsContentless], [created]);
	assert.deepEqual(refused.statements, []);
	assert.deepEqual(refused.refusals, [
		'Changing "memo" recreates it empty, because a contentless index can\'t be refilled from a table. Pass --allow-data-loss to do it anyway.',
		'Changing "docs" recreates it empty, because a standalone index can\'t be refilled from a table. Pass --allow-data-loss to do it anyway.',
	]);
	const allowed = planMigration([memoChanged, docsContentless], [created], {allowDataLoss: true});
	assert.deepEqual(allowed.statements, [...dropIndexSql(memoSpec), ...createSql(memoChanged), ...dropIndexSql(docsSpec), ...createSql(docsContentless)]);
	assert.deepEqual(allowed.changes, ['recreate memo', 'recreate docs']);
});

test('an index that is no longer declared is dropped with its triggers', () => {
	const created = written(planMigration([notesSpec, docsSpec], [createNotes]));
	const plan = planMigration([docsSpec], [createNotes, created]);
	assert.deepEqual(plan.statements, dropIndexSql(notesSpec));
	assert.deepEqual(plan.marker, {version: 1, set: [], created: [], drop: ['notes_fts']});
	assert.deepEqual(plan.changes, ['drop notes_fts']);
	assert.deepEqual(planMigration([docsSpec], [createNotes, created, written(plan)]).statements, []);
});

test('specs compare by value, whatever order the marker wrote their keys in', () => {
	const reordered = JSON.stringify({version: 1, set: [{content: {rowid: 'id', table: 'notes'}, columns: ['title', 'body'], mode: 'external', name: 'notes_fts'}], created: ['notes_fts'], drop: []});
	assert.deepEqual(planMigration([notesSpec], [createNotes, `-- drizzle-sqlite-fts:state ${reordered}`]).statements, []);
});

test('renaming an index in letter case only changes nothing, since SQLite sees the same table', () => {
	const created = written(planMigration([memoSpec, notesSpec], [createNotes]));
	const plan = planMigration([{...memoSpec, name: 'Memo'}, {...notesSpec, name: 'Notes_FTS'}], [createNotes, created]);
	assert.deepEqual(plan.statements, []);
	assert.deepEqual(plan.refusals, []);
});

test('branches that disagree about an index are refused until one of their migrations is deleted', () => {
	const base = written(planMigration([docsSpec], []));
	const wider = {...docsSpec, columns: ['title', 'body']};
	const createdTwice = planMigration([wider], [written(planMigration([docsSpec], [])), written(planMigration([wider], []))]);
	assert.deepEqual(createdTwice.statements, []);
	assert.deepEqual(createdTwice.marker, {version: 1, set: [], created: [], drop: []});
	assert.deepEqual(createdTwice.refusals, ['Two migrations create "docs" with different settings, and the database keeps whichever ran first. Delete the later migration that creates it, then run this again.']);

	const dropped = written(planMigration([], [base]));
	const changed = written(planMigration([wider], [base]));
	assert.deepEqual(planMigration([wider], [base, dropped, changed]).refusals, ['A migration changes "docs" after an earlier one dropped it, so it fails when it runs. Delete the migration that changes it, then run this again.']);
	assert.deepEqual(planMigration([wider], [base, dropped]).changes, ['create docs'], 'with the changing migration deleted, the index is created again');
});

test('duplicate declarations and columns that collide after casing are refused', () => {
	assert.throws(() => planMigration([docsSpec, {...docsSpec, name: 'DOCS'}], []), /Two fts5\(\) declarations are named "DOCS"/);
	assert.throws(() => planMigration([{...docsSpec, columns: ['body_text', 'Body_Text']}], []), /lists the column "Body_Text" twice/);
	assert.throws(() => planMigration([{...docsSpec, columns: ['rank']}], []), /can't index a column named "rank"/);
});

test('on a real database: backfill, then a drizzle-kit rebuild, then the repair keeps search in sync', () => {
	const client = new Database(':memory:');
	const migrations = [createNotes];
	const apply = (migration: string) => {
		runMigration(client, migration);
		migrations.push(migration);
	};

	runMigration(client, createNotes);
	client.exec('INSERT INTO notes (id, title, body) VALUES (1, \'alpha\', \'first\'), (2, \'beta\', \'second\'), (3, \'gamma\', \'third\')');
	apply(written(planMigration([notesSpec], migrations)));
	assert.deepEqual(search(client, 'notes_fts', 'second'), [2]);
	client.exec('UPDATE notes SET body = \'zebra\' WHERE id = 1');
	assert.deepEqual(search(client, 'notes_fts', 'zebra'), [1]);
	assert.deepEqual(search(client, 'notes_fts', 'first'), []);

	apply(rebuildNotes);
	client.exec('INSERT INTO notes (id, title) VALUES (4, \'delta\')');
	assert.deepEqual(search(client, 'notes_fts', 'delta'), [], 'the rebuild dropped the triggers');

	apply(written(planMigration([notesSpec], migrations)));
	assert.deepEqual(search(client, 'notes_fts', 'delta'), [4]);
	client.exec('INSERT INTO notes (id, title) VALUES (5, \'epsilon\')');
	assert.deepEqual(search(client, 'notes_fts', 'epsilon'), [5]);
	assertIntact(client, 'notes_fts');
	assert.deepEqual(planMigration([notesSpec], migrations).statements, []);
});
