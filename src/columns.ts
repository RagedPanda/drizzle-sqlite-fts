import {toCamelCase, toSnakeCase} from 'drizzle-orm/casing';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import type {SQLiteColumn} from 'drizzle-orm/sqlite-core';

/** The `casing` option of `drizzle()` and `drizzle.config.ts`. */
export type Casing = 'snake_case' | 'camelCase';

/**
 * Drizzle 1.0 applies casing in the table builder (`snakeCase.table()`), so columns already carry their
 * database names, and drizzle-kit ignores the `casing` in `drizzle.config.ts`. Before 1.0, `casing` renames them.
 */
export const casingInTableBuilders = 'snakeCase' in sqliteCore;

/** The `casing` to apply to key-named columns: none when the installed Drizzle applies it in the table builder. */
export function effectiveCasing(casing: Casing | undefined, inTableBuilders = casingInTableBuilders): Casing | undefined {
	return inTableBuilders ? undefined : casing;
}

/**
 * The database name of `column`. A column declared without a name (`bodyText: text()`) is named
 * after its key, and Drizzle's `casing` option renames it; a column with an explicit name keeps it.
 */
export function columnName(column: SQLiteColumn, casing: Casing | undefined): string {
	if (!column.keyAsName || casing === undefined) {
		return column.name;
	}

	return casing === 'snake_case' ? toSnakeCase(column.name) : toCamelCase(column.name);
}
