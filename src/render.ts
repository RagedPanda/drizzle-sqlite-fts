import {triggerNames} from './declare.ts';
import {quoteIdentifier, quoteLiteral} from './identifiers.ts';
import type {IndexSpec} from './spec.ts';

/** What drizzle-kit puts between statements, so its migrator runs each one on its own. */
export const statementBreakpoint = '--> statement-breakpoint';

export function joinStatements(statements: readonly string[]): string {
	return statements.join(`\n${statementBreakpoint}\n`);
}

function contentOptions(spec: IndexSpec): string[] {
	if (spec.content !== undefined) {
		return [`content=${quoteLiteral(spec.content.table)}`, `content_rowid=${quoteLiteral(spec.content.rowid)}`];
	}

	return spec.mode === 'contentless' ? ['content=\'\''] : [];
}

function tuningOptions(spec: IndexSpec): string[] {
	const options: string[] = [];
	if (spec.tokenize !== undefined) {
		options.push(`tokenize=${quoteLiteral(spec.tokenize)}`);
	}

	if (spec.prefix !== undefined) {
		options.push(`prefix=${quoteLiteral(spec.prefix.join(' '))}`);
	}

	if (spec.detail !== undefined) {
		options.push(`detail=${spec.detail}`);
	}

	if (spec.columnsize === false) {
		options.push('columnsize=0');
	}

	return options;
}

export function createIndexSql(spec: IndexSpec): string {
	const columns = spec.columns.map(quoteIdentifier);
	const options = [...columns, ...contentOptions(spec), ...tuningOptions(spec)];
	return `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(spec.name)} USING fts5(${options.join(', ')});`;
}

/** `new."id", new."title"`: the rowid and indexed values of the row a trigger fires for. */
function rowValues(prefix: 'new' | 'old', spec: IndexSpec & {content: object}): string {
	return [spec.content.rowid, ...spec.columns].map(name => `${prefix}.${quoteIdentifier(name)}`).join(', ');
}

/**
 * The insert, delete and update triggers that keep an external-content index in step with its table, following
 * the sqlite.org recipe. The update trigger only fires when an indexed column or the rowid column changes.
 * Contentless and standalone indexes have no content table, so they get none.
 */
export function createTriggersSql(spec: IndexSpec): string[] {
	if (spec.content === undefined) {
		return [];
	}

	const external = spec as IndexSpec & {content: object};
	const names = triggerNames(spec.name);
	const index = quoteIdentifier(spec.name);
	const table = quoteIdentifier(spec.content.table);
	const columns = ['rowid', ...spec.columns.map(quoteIdentifier)].join(', ');
	const insertNew = `INSERT INTO ${index}(${columns}) VALUES (${rowValues('new', external)});`;
	const deleteOld = `INSERT INTO ${index}(${index}, ${columns}) VALUES ('delete', ${rowValues('old', external)});`;
	const watched = [...new Set([spec.content.rowid, ...spec.columns])].map(quoteIdentifier).join(', ');
	const trigger = (name: string, event: string, body: string[]) =>
		[`CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(name)} AFTER ${event} ON ${table} BEGIN`, ...body.map(line => `\t${line}`), 'END;'].join('\n');
	return [
		trigger(names.insert, 'INSERT', [insertNew]),
		trigger(names.delete, 'DELETE', [deleteOld]),
		trigger(names.update, `UPDATE OF ${watched}`, [deleteOld, insertNew]),
	];
}

/** Rebuilds an external-content index from its table, as after it is created over rows that already exist. */
export function rebuildSql(spec: IndexSpec): string {
	const index = quoteIdentifier(spec.name);
	return `INSERT INTO ${index}(${index}) VALUES ('rebuild');`;
}

export function dropTriggersSql(spec: IndexSpec): string[] {
	if (spec.content === undefined) {
		return [];
	}

	return Object.values(triggerNames(spec.name)).map(name => `DROP TRIGGER IF EXISTS ${quoteIdentifier(name)};`);
}

export function dropIndexSql(spec: IndexSpec): string[] {
	return [...dropTriggersSql(spec), `DROP TABLE IF EXISTS ${quoteIdentifier(spec.name)};`];
}

/** Creates an index with its triggers, filling an external-content index from the rows its table already has. */
export function createSql(spec: IndexSpec): string[] {
	return [createIndexSql(spec), ...createTriggersSql(spec), ...spec.content === undefined ? [] : [rebuildSql(spec)]];
}

/**
 * Replaces a standalone index with `next`, copying its rows across: the old index is renamed aside, the new one
 * created, the columns both share copied by rowid, and the old one dropped. FTS5 can't change options in place.
 */
export function copyStandaloneSql(previous: IndexSpec, next: IndexSpec): string[] {
	if (previous.mode !== 'standalone') {
		throw new TypeError(`Only a standalone index keeps its rows to copy, but "${previous.name}" is ${previous.mode}`);
	}

	const aside = quoteIdentifier(`__old_${previous.name}`);
	// SQLite compares column names case-insensitively, so "Title" renamed to "title" is still the same column.
	const previousByLowerName = new Map(previous.columns.map(column => [column.toLowerCase(), column]));
	const shared = next.columns.flatMap(column => {
		const previousColumn = previousByLowerName.get(column.toLowerCase());
		return previousColumn === undefined ? [] : [[quoteIdentifier(column), quoteIdentifier(previousColumn)] as const];
	});
	const targetColumns = ['rowid', ...shared.map(([target]) => target)].join(', ');
	const sourceColumns = ['rowid', ...shared.map(([, source]) => source)].join(', ');
	return [
		`ALTER TABLE ${quoteIdentifier(previous.name)} RENAME TO ${aside};`,
		createIndexSql(next),
		`INSERT INTO ${quoteIdentifier(next.name)}(${targetColumns}) SELECT ${sourceColumns} FROM ${aside};`,
		`DROP TABLE ${aside};`,
	];
}
