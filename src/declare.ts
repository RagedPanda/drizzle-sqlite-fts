import {getTableColumns, getTableName, is, type InferSelectModel} from 'drizzle-orm';
import {getTableConfig, integer, real, SQLiteTable, sqliteView, text, type SQLiteColumn} from 'drizzle-orm/sqlite-core';
import {casingInTableBuilders} from './columns.ts';
import {assertName} from './identifiers.ts';

// A registered symbol, so an index still matches when a schema file loads a second copy of this package.
export const fts5Definition: unique symbol = Symbol.for('drizzle-sqlite-fts.definition') as never;

/**
 * `external`: the index reads its text from a Drizzle table and triggers keep it in sync.
 * `contentless`: the index stores no text, so it can't return column values, highlight or snippet; you insert rows yourself.
 * `standalone`: the index stores its own copy of the text; you insert rows yourself.
 */
export type Fts5Mode = 'external' | 'contentless' | 'standalone';

export type Fts5Options = {
	/** The tokenizer and its arguments, such as `porter unicode61 remove_diacritics 2` or `trigram`. Defaults to FTS5's `unicode61`. */
	readonly tokenize?: string;
	/** Prefix lengths to build extra indexes for, from 1 to 999, so prefix searches of those lengths are fast. */
	readonly prefix?: readonly number[];
	/** How much position information to store. Defaults to `full`; `column` and `none` make the index smaller but disable phrase and NEAR queries. */
	readonly detail?: 'full' | 'column' | 'none';
	/** Set to false to stop storing each row's token count, which makes the index smaller and bm25 slower. Defaults to true. */
	readonly columnsize?: boolean;
};

type ColumnKey<TTable extends SQLiteTable> = keyof InferSelectModel<TTable> & string;

export type ExternalContentOptions<TTable extends SQLiteTable, TKey extends ColumnKey<TTable>> = Fts5Options & {
	/** External content is the default, so this can be left out. */
	readonly mode?: 'external';
	/** The table whose rows the index searches. */
	readonly table: TTable;
	/** The keys of the text columns to index, in the order bm25 weights refer to them. */
	readonly columns: readonly TKey[];
	/** A unique, not-null integer column that identifies each row. Defaults to the table's `integer` primary key. */
	readonly contentRowid?: ColumnKey<TTable>;
};

export type DetachedOptions<TMode extends 'contentless' | 'standalone', TColumn extends string> = Fts5Options & {
	readonly mode: TMode;
	/** The names of the index's columns. */
	readonly columns: readonly TColumn[];
};

/** A column of an index: its key on the handle, and for external-content indexes the content column it mirrors. */
export type IndexedColumn = {
	readonly key: string;
	readonly column: SQLiteColumn | undefined;
};

type DefinitionBase = Fts5Options & {
	readonly name: string;
	readonly columns: readonly IndexedColumn[];
};

export type ExternalContentDefinition = DefinitionBase & {
	readonly mode: 'external';
	readonly table: SQLiteTable;
	/** The integer column FTS5 uses as each row's rowid. */
	readonly contentRowid: SQLiteColumn;
};

export type DetachedDefinition<TMode extends 'contentless' | 'standalone' = 'contentless' | 'standalone'> = DefinitionBase & {
	readonly mode: TMode;
};

export type Fts5Definition = ExternalContentDefinition | DetachedDefinition;

type DefinitionFor<TMode extends Fts5Mode> = TMode extends 'external' ? ExternalContentDefinition : DetachedDefinition<Exclude<TMode, 'external'>>;

// Builders whose return types describe the handle's columns on every supported Drizzle version.
const optionalText = () => text();
const requiredText = () => text().notNull();
const rowidColumn = () => integer('rowid').notNull();
// FTS5 gives rank only to rows found by MATCH; other queries read it as NULL.
const rankColumn = () => real('rank');

type HandleColumns<TColumns> = TColumns & {
	readonly rowid: ReturnType<typeof rowidColumn>;
	readonly rank: ReturnType<typeof rankColumn>;
};

type ExternalColumns<TTable extends SQLiteTable, TKey extends ColumnKey<TTable>> = {
	readonly [Key in TKey]: null extends InferSelectModel<TTable>[Key] ? ReturnType<typeof optionalText> : ReturnType<typeof requiredText>;
};

type DetachedColumns<TColumn extends string> = {
	readonly [Key in TColumn]: ReturnType<typeof optionalText>;
};

type ExistingView<TName extends string, TColumns extends Parameters<typeof sqliteView>[1]> = ReturnType<ReturnType<typeof sqliteView<TName, TColumns>>['existing']>;

/**
 * The value `fts5()` returns: a Drizzle view of the FTS5 table, to select from, join and search,
 * that also carries the index definition the CLI reads.
 */
export type Fts5Index<TName extends string, TColumns extends Parameters<typeof sqliteView>[1], TMode extends Fts5Mode> = ExistingView<TName, HandleColumns<TColumns>> & {
	readonly [fts5Definition]: DefinitionFor<TMode>;
	readonly [indexedColumnKeys]?: keyof TColumns & string;
};

/** Type-only: carries the keys of an index's columns, so the query helpers can check a column name. */
declare const indexedColumnKeys: unique symbol;

/** The keys of the columns `TIndex` indexes, without `rowid` and `rank`. */
export type IndexedColumnKey<TIndex extends AnyFts5Index> = NonNullable<TIndex[typeof indexedColumnKeys]>;

/** Any value `fts5()` returns. */
export type AnyFts5Index = {
	readonly [fts5Definition]: Fts5Definition;
	readonly [indexedColumnKeys]?: string;
};

/** FTS5 rejects these as column names, in any letter case, and the handle uses them for its own columns. */
const reservedColumnNames = new Set(['rank', 'rowid']);
const detailLevels = new Set(['full', 'column', 'none']);

/**
 * Declares an FTS5 full-text index. Export the result from your schema so `drizzle-sqlite-fts generate`
 * finds it, and use it in queries like a table.
 *
 * ```ts
 * export const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body'], tokenize: 'porter unicode61'});
 * ```
 */
export function fts5<TName extends string, TTable extends SQLiteTable, const TKey extends ColumnKey<TTable>>(
	name: TName,
	options: ExternalContentOptions<TTable, TKey>,
): Fts5Index<TName, ExternalColumns<TTable, TKey>, 'external'>;
export function fts5<TName extends string, TMode extends 'contentless' | 'standalone', const TColumn extends string>(
	name: TName,
	options: DetachedOptions<TMode, TColumn>,
): Fts5Index<TName, DetachedColumns<TColumn>, TMode>;
export function fts5(name: string, options: ExternalContentOptions<SQLiteTable, string> | DetachedOptions<'contentless' | 'standalone', string>): AnyFts5Index {
	assertName(name, 'The fts5() index name');
	if (typeof options !== 'object' || options === null) {
		throw new TypeError(`fts5("${name}") needs an options object as its second argument`);
	}

	const definition = options.mode === undefined || options.mode === 'external'
		? externalContentDefinition(name, options as ExternalContentOptions<SQLiteTable, string>)
		: detachedDefinition(name, options as DetachedOptions<'contentless' | 'standalone', string>);
	assertValidNames(definition);
	const view = sqliteView(name, handleColumns(definition)).existing();
	Object.defineProperty(view, fts5Definition, {value: definition});
	return view as unknown as AnyFts5Index;
}

/** The definition behind a value `fts5()` returned, or undefined for any other value. */
export function getFts5Definition(value: unknown): Fts5Definition | undefined {
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
		return undefined;
	}

	return (value as Partial<AnyFts5Index>)[fts5Definition];
}

/** The names of the insert, update and delete triggers that keep an external-content index in sync. */
export function triggerNames(indexName: string): {readonly insert: string; readonly update: string; readonly delete: string} {
	return {insert: `${indexName}_ai`, update: `${indexName}_au`, delete: `${indexName}_ad`};
}

function externalContentDefinition(name: string, options: ExternalContentOptions<SQLiteTable, string>): ExternalContentDefinition {
	if (!is(options.table, SQLiteTable)) {
		throw new TypeError(`fts5("${name}") needs a Drizzle sqliteTable as its table`);
	}

	const tableName = getTableName(options.table);
	if (tableName.toLowerCase() === name.toLowerCase()) {
		throw new TypeError(`fts5("${name}") can't have the same name as the table it indexes; name it "${tableName}_fts"`);
	}

	const tableColumns = getTableColumns(options.table) as Record<string, SQLiteColumn>;
	const columns = columnKeys(name, options.columns).map(key => {
		const column = tableColumns[key];
		if (column === undefined) {
			throw new TypeError(`fts5("${name}"): table "${tableName}" has no column with the key "${key}"`);
		}

		if (column.columnType === 'SQLiteTextJson') {
			throw new TypeError(`fts5("${name}"): column "${key}" of "${tableName}" holds JSON, so FTS5 would index its keys and punctuation. Index a text column instead.`);
		}

		if (!hasTextAffinity(column.getSQLType())) {
			throw new TypeError(`fts5("${name}"): column "${key}" of "${tableName}" is ${column.getSQLType()}, but FTS5 indexes text columns`);
		}

		return {key, column};
	});
	return {
		...fts5Options(options),
		name,
		mode: 'external',
		table: options.table,
		columns,
		contentRowid: contentRowidColumn(name, options.table, tableColumns, options.contentRowid),
	};
}

function detachedDefinition(name: string, options: DetachedOptions<'contentless' | 'standalone', string>): DetachedDefinition {
	if (options.mode !== 'contentless' && options.mode !== 'standalone') {
		throw new TypeError(`fts5("${name}") mode must be "contentless" or "standalone", or left out for an index over a table; got ${JSON.stringify(options.mode)}`);
	}

	return {
		...fts5Options(options),
		name,
		mode: options.mode,
		columns: columnKeys(name, options.columns).map(key => ({key, column: undefined})),
	};
}

function columnKeys(name: string, keys: unknown): readonly string[] {
	if (!Array.isArray(keys) || keys.length === 0) {
		throw new TypeError(`fts5("${name}") needs at least one column`);
	}

	for (const key of keys) {
		assertName(key, `fts5("${name}") column`);
	}

	return keys as readonly string[];
}

/** SQLite's column affinity rules: a type naming INT is an integer, else one naming CHAR, CLOB or TEXT is text. */
function hasTextAffinity(sqlType: string): boolean {
	const type = sqlType.toUpperCase();
	return !type.includes('INT') && /CHAR|CLOB|TEXT/.test(type);
}

/** Only the options that were given, so definitions compare equal however they were written. */
function fts5Options(options: Fts5Options): Fts5Options {
	const {tokenize, prefix, detail, columnsize} = options;
	if (prefix !== undefined && (!Array.isArray(prefix) || prefix.length === 0)) {
		throw new TypeError(`fts5() prefix must be a non-empty array of lengths, got ${JSON.stringify(prefix)}`);
	}

	return {
		...(tokenize === undefined ? {} : {tokenize}),
		...(prefix === undefined ? {} : {prefix: [...prefix]}),
		...(detail === undefined ? {} : {detail}),
		...(columnsize === undefined ? {} : {columnsize}),
	};
}

/** Columns that identify a row on their own: a one-column primary key, unique constraint or unique index. */
function singleColumnKeys(table: SQLiteTable): {primary: readonly unknown[]; unique: ReadonlySet<unknown>} {
	const config = getTableConfig(table);
	const loneColumn = (columns: readonly unknown[]) => columns.length === 1 ? columns : [];
	const primary = [...config.columns.filter(column => column.primary), ...config.primaryKeys.flatMap(key => loneColumn(key.columns))];
	const unique = new Set<unknown>([
		...primary,
		...config.columns.filter(column => column.isUnique),
		...config.uniqueConstraints.flatMap(constraint => loneColumn(constraint.columns)),
		...config.indexes.filter(index => index.config.unique).flatMap(index => loneColumn(index.config.columns)),
	]);
	return {primary, unique};
}

/**
 * External content must be found by a stable integer key. SQLite can renumber the implicit rowid of a table
 * without an `INTEGER PRIMARY KEY` on VACUUM, which would point the index at the wrong rows.
 */
function contentRowidColumn(name: string, table: SQLiteTable, tableColumns: Record<string, SQLiteColumn>, key: string | undefined): SQLiteColumn {
	const tableName = getTableName(table);
	const keys = singleColumnKeys(table);
	if (key !== undefined) {
		const column = tableColumns[key];
		if (column?.getSQLType() !== 'integer' || !keys.unique.has(column) || !(column.notNull || keys.primary.includes(column))) {
			throw new TypeError(`fts5("${name}") contentRowid must be the key of a unique, not-null integer column of "${tableName}", got ${JSON.stringify(key)}`);
		}

		return column;
	}

	const [primaryKey, ...others] = Object.values(tableColumns).filter(column => keys.primary.includes(column));
	if (primaryKey?.getSQLType() !== 'integer' || others.length > 0) {
		throw new TypeError(`fts5("${name}") needs a stable integer key for "${tableName}", which has no integer primary key. Add one, such as \`id: integer().primaryKey()\`, or pass the key of a unique integer column as \`contentRowid\`.`);
	}

	return primaryKey;
}

/**
 * Throws when an index's database column names include one FTS5 reserves, or the same name twice.
 * Names compare case-insensitively, as SQLite compares them.
 */
export function assertColumnNames(indexName: string, columnNames: readonly string[]): void {
	const seen = new Set<string>();
	for (const columnName of columnNames) {
		const lowerName = columnName.toLowerCase();
		if (reservedColumnNames.has(lowerName) || lowerName === indexName.toLowerCase()) {
			throw new TypeError(`fts5("${indexName}") can't index a column named "${columnName}", because FTS5 reserves it. Rename the column.`);
		}

		if (seen.has(lowerName)) {
			throw new TypeError(`fts5("${indexName}") lists the column "${columnName}" twice`);
		}

		seen.add(lowerName);
	}
}

function assertValidNames(definition: Fts5Definition): void {
	const {name} = definition;
	for (const {key} of definition.columns) {
		if (reservedColumnNames.has(key)) {
			throw new TypeError(`fts5("${name}") can't index a column with the key "${key}", because the handle uses it for FTS5's own ${key}. Rename the key.`);
		}
	}

	assertColumnNames(name, definition.columns.map(({key, column}) => column?.name ?? key));

	if (definition.tokenize !== undefined) {
		assertName(definition.tokenize, `fts5("${name}") tokenize`);
	}

	if (definition.detail !== undefined && !detailLevels.has(definition.detail)) {
		throw new TypeError(`fts5("${name}") detail must be "full", "column" or "none", got ${JSON.stringify(definition.detail)}`);
	}

	if (definition.columnsize !== undefined && typeof definition.columnsize !== 'boolean') {
		throw new TypeError(`fts5("${name}") columnsize must be true or false, got ${JSON.stringify(definition.columnsize)}`);
	}

	for (const length of definition.prefix ?? []) {
		if (!Number.isInteger(length) || length < 1 || length > 999) {
			throw new TypeError(`fts5("${name}") prefix lengths must be integers from 1 to 999, got ${JSON.stringify(length)}`);
		}
	}
}

/** The handle's columns: each indexed column, then FTS5's `rowid` and `rank`. */
function handleColumns(definition: Fts5Definition): Record<string, ReturnType<typeof optionalText> | ReturnType<typeof rowidColumn> | ReturnType<typeof rankColumn>> {
	return {
		...Object.fromEntries(definition.columns.map(({key, column}) => [key, handleColumn(key, column)])),
		rowid: rowidColumn(),
		rank: rankColumn(),
	};
}

/**
 * A key-named content column gets a key-named handle column, so Drizzle's `casing` option renames both alike.
 * Drizzle 1.0 names columns in the table builder, so there the handle copies the name.
 */
function handleColumn(key: string, column: SQLiteColumn | undefined) {
	if (column?.keyAsName === true && !casingInTableBuilders) {
		return column.notNull ? requiredText() : optionalText();
	}

	const builder = text(column?.name ?? key);
	return column?.notNull === true ? builder.notNull() : builder;
}
