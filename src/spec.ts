import {getTableName} from 'drizzle-orm';
import {columnName, type Casing} from './columns.ts';
import type {Fts5Definition, Fts5Mode, Fts5Options} from './declare.ts';

/**
 * An index as the database sees it: plain names and options, with casing already applied.
 * Rendering works from this shape, so an index recorded in an earlier migration renders the same way as a declared one.
 */
export type IndexSpec = Fts5Options & {
	readonly name: string;
	readonly mode: Fts5Mode;
	/** The index's column names, which for an external-content index are its content table's column names. */
	readonly columns: readonly string[];
	/** The content table and its rowid column, for an external-content index. */
	readonly content?: {readonly table: string; readonly rowid: string};
};

/** The database view of `definition` under Drizzle's `casing` option. */
export function toIndexSpec(definition: Fts5Definition, casing: Casing | undefined): IndexSpec {
	const columns = definition.columns.map(({key, column}) => column === undefined ? key : columnName(column, casing));
	const content = definition.mode === 'external'
		? {content: {table: getTableName(definition.table), rowid: columnName(definition.contentRowid, casing)}}
		: {};
	return {
		name: definition.name,
		mode: definition.mode,
		columns,
		...content,
		...definition.tokenize === undefined ? {} : {tokenize: definition.tokenize},
		...definition.prefix === undefined ? {} : {prefix: [...definition.prefix]},
		...definition.detail === undefined ? {} : {detail: definition.detail},
		...definition.columnsize === undefined ? {} : {columnsize: definition.columnsize},
	};
}
