import {getFts5Definition, type AnyFts5Index} from './declare.ts';

/**
 * `tablesFilter` globs for `drizzle.config.ts` that hide each index and its FTS5 shadow tables from `drizzle-kit push`,
 * which would otherwise drop them as tables the schema doesn't declare. Spread them into your own filter, if you have one.
 */
export function ftsTablesFilter(...indexes: readonly AnyFts5Index[]): string[] {
	return indexes.flatMap(index => {
		const definition = getFts5Definition(index);
		if (definition === undefined) {
			throw new TypeError('ftsTablesFilter() takes the indexes that fts5() returned');
		}

		return [`!${definition.name}`, `!${definition.name}_*`];
	});
}
