import assert from 'node:assert/strict';
import {test} from 'node:test';
import {toMatchQuery} from '../src/query.ts';

test('every term is quoted, so FTS5 syntax in user input is plain text', () => {
	assert.equal(toMatchQuery('"C++" OR'), '"""C++""" "OR"');
	assert.equal(toMatchQuery('NEAR( a -b title:c'), '"NEAR(" "a" "-b" "title:c"');
	assert.equal(toMatchQuery('  spaced\tout\nterms  '), '"spaced" "out" "terms"');
});

test('a prefix applies to the last term only', () => {
	assert.equal(toMatchQuery('big dat', {prefix: true}), '"big" "dat"*');
	assert.equal(toMatchQuery('dat', {prefix: false}), '"dat"');
});

test('input with no terms becomes a query that matches nothing', () => {
	for (const text of ['', '   ', '\n\t']) {
		assert.equal(toMatchQuery(text), '""');
		assert.equal(toMatchQuery(text, {prefix: true}), '""');
	}
});
