import assert from 'node:assert/strict';
import {test} from 'node:test';
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {columnName, effectiveCasing} from '../src/columns.ts';

const table = sqliteTable('people', {
	id: integer().primaryKey(),
	displayName: text(),
	first_name: text(),
	nickName: text('nick_name'),
});

test('casing renames key-named columns only', () => {
	assert.equal(columnName(table.displayName, undefined), 'displayName');
	assert.equal(columnName(table.displayName, 'snake_case'), 'display_name');
	assert.equal(columnName(table.first_name, 'camelCase'), 'firstName');
	assert.equal(columnName(table.nickName, 'camelCase'), 'nick_name');
});

test('casing is ignored when the table builder already applied it', () => {
	assert.equal(effectiveCasing('snake_case', false), 'snake_case');
	assert.equal(effectiveCasing('snake_case', true), undefined);
});
