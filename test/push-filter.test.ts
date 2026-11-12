import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fts5, ftsTablesFilter} from '../src/index.ts';
import {notes} from './fixtures.ts';

test('ftsTablesFilter hides each index and its shadow tables, and nothing else', () => {
	const notesSearch = fts5('notes_fts', {table: notes, columns: ['title']});
	const memo = fts5('memo', {mode: 'contentless', columns: ['text']});
	assert.deepEqual(ftsTablesFilter(notesSearch, memo), ['!notes_fts', '!notes_fts_*', '!memo', '!memo_*']);
	assert.deepEqual(ftsTablesFilter(), []);
	assert.throws(() => ftsTablesFilter(notes as never), /ftsTablesFilter\(\) takes the indexes that fts5\(\) returned/);
});
