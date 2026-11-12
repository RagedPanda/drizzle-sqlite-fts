import assert from 'node:assert/strict';
import {test} from 'node:test';
import {droppedSince, tableEvents, tableExists, unquote} from '../src/table-events.ts';

test('drizzle-kit\'s table rebuild reads as a drop of the table and a create under the same name', () => {
	const rebuild = [
		'PRAGMA foreign_keys=OFF;--> statement-breakpoint',
		'CREATE TABLE `__new_notes` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL\n);',
		'--> statement-breakpoint',
		'INSERT INTO `__new_notes`("id", "title") SELECT "id", "title" FROM `notes`;--> statement-breakpoint',
		'DROP TABLE `notes`;--> statement-breakpoint',
		'ALTER TABLE `__new_notes` RENAME TO `notes`;--> statement-breakpoint',
		'PRAGMA foreign_keys=ON;',
	].join('\n');
	assert.deepEqual(tableEvents(rebuild), [
		{kind: 'create', table: '__new_notes'},
		{kind: 'drop', table: 'notes'},
		{kind: 'drop', table: '__new_notes'},
		{kind: 'create', table: 'notes'},
	]);
});

test('every quoting style, schema prefixes, IF [NOT] EXISTS and virtual tables are read', () => {
	const sql = [
		'create table if not exists "We""ird" (a);',
		'CREATE TEMP TABLE [Bracketed] (a);',
		'CREATE VIRTUAL TABLE main.plain USING fts5(a);',
		'DROP TABLE IF EXISTS `main`.`Gone`;',
		'alter table "old" rename to new_name;',
	].join('\n');
	assert.deepEqual(tableEvents(sql), [
		{kind: 'create', table: 'we"ird'},
		{kind: 'create', table: 'bracketed'},
		{kind: 'create', table: 'plain'},
		{kind: 'drop', table: 'gone'},
		{kind: 'drop', table: 'old'},
		{kind: 'create', table: 'new_name'},
	]);
});

test('statements inside string literals and comments are not read', () => {
	const sql = [
		'INSERT INTO log VALUES (\'DROP TABLE notes\');',
		'-- DROP TABLE notes',
		'/* CREATE TABLE ghosts (a); */',
		'-- drizzle-sqlite-fts:state {"version":1,"set":[],"drop":["DROP TABLE notes"]}',
	].join('\n');
	assert.deepEqual(tableEvents(sql), []);
});

test('unquote strips each quoting style and lowercases', () => {
	assert.equal(unquote('"A""b"'), 'a"b');
	assert.equal(unquote('`A``b`'), 'a`b');
	assert.equal(unquote('[A b]'), 'a b');
	assert.equal(unquote('Plain'), 'plain');
});

test('a table exists when its last event is a create, and drops count only after the given migration', () => {
	const events = [
		tableEvents('CREATE TABLE notes (id integer);'),
		tableEvents('SELECT 1;'),
		tableEvents('DROP TABLE notes;'),
	];
	assert.equal(tableExists(events.slice(0, 2), 'NOTES'), true);
	assert.equal(tableExists(events, 'notes'), false);
	assert.equal(tableExists(events, 'posts'), false);
	assert.equal(droppedSince(events, 'Notes', 0), true);
	assert.equal(droppedSince(events, 'notes', 2), false);
	assert.equal(droppedSince(events, 'posts', 0), false);
});
