import {sql, type SQL} from 'drizzle-orm';
import {getFts5Definition, type AnyFts5Index, type fts5Definition, type Fts5Definition, type IndexedColumnKey} from './declare.ts';

export type MatchOptions = {
	/** Match words that start with the last term, for search-as-you-type. Needs no `prefix` index, but one makes it faster. */
	readonly prefix?: boolean;
};

/** Rules out contentless indexes: highlight and snippet read the indexed text, which a contentless index doesn't keep. */
type KeepsText<TIndex extends AnyFts5Index> = TIndex[typeof fts5Definition]['mode'] extends 'contentless' ? never : unknown;

/** An FTS5 phrase that never matches: no row has an empty phrase, and FTS5 accepts it where `MATCH ''` is an error. */
const matchesNothing = '""';

/**
 * Turns what a user typed into an FTS5 query that can't be a syntax error: each whitespace-separated term becomes
 * a quoted phrase, so `OR`, `NEAR(`, `-` and `"` are plain text, and the terms must all appear. With `prefix`,
 * the last term also matches words that start with it.
 */
export function toMatchQuery(text: string, options: MatchOptions = {}): string {
	const terms = text.split(/\s+/u).filter(term => term !== '').map(term => `"${term.replaceAll('"', '""')}"`);
	if (terms.length === 0) {
		return matchesNothing;
	}

	return options.prefix === true ? `${terms.join(' ')}*` : terms.join(' ');
}

function definitionOf(index: AnyFts5Index, helper: string): Fts5Definition {
	const definition = getFts5Definition(index);
	if (definition === undefined) {
		throw new TypeError(`${helper}() needs an index that fts5() returned`);
	}

	return definition;
}

/** The position FTS5 gives `key` among the index's columns, counting from 0. */
function columnPosition(definition: Fts5Definition, key: string, helper: string): number {
	const position = definition.columns.findIndex(column => column.key === key);
	if (position === -1) {
		throw new TypeError(`${helper}(): "${definition.name}" has no column with the key ${JSON.stringify(key)}`);
	}

	return position;
}

function assertHasText(definition: Fts5Definition, helper: string): void {
	if (definition.mode === 'contentless') {
		throw new TypeError(`${helper}() needs the indexed text, which the contentless index "${definition.name}" doesn't keep`);
	}
}

/**
 * Matches rows containing every term of `text`, typed by a user. The text is sent as a bound parameter, and
 * input with no terms matches no rows. Use it in `where()`.
 */
export function match(index: AnyFts5Index, text: string, options: MatchOptions = {}): SQL {
	return rawMatch(index, toMatchQuery(text, options));
}

/** Matches rows with an FTS5 query as written, such as `title: alpha OR beta`. Only pass queries you wrote, not user input. */
export function rawMatch(index: AnyFts5Index, query: string): SQL {
	const definition = definitionOf(index, 'match');
	return sql`${sql.identifier(definition.name)} MATCH ${query}`;
}

/**
 * The bm25 relevance of each matched row, where lower is more relevant, so `orderBy()` it ascending.
 * Weights are by column key; columns you leave out weigh 1. Only valid in a query with `match()`.
 */
export function bm25<TIndex extends AnyFts5Index>(index: TIndex, weights: Partial<Record<IndexedColumnKey<TIndex>, number>> = {}): SQL<number> {
	const definition = definitionOf(index, 'bm25');
	for (const [key, weight] of Object.entries(weights)) {
		columnPosition(definition, key, 'bm25');
		if (typeof weight !== 'number' || !Number.isFinite(weight)) {
			throw new TypeError(`bm25(): the weight of "${key}" must be a finite number, got ${JSON.stringify(weight)}`);
		}
	}

	const columnWeights = definition.columns.map(({key}) => (weights as Record<string, number | undefined>)[key] ?? 1);
	return sql<number>`bm25(${sql.identifier(definition.name)}, ${sql.join(columnWeights.map(weight => sql.raw(String(weight))), sql`, `)})`;
}

export type HighlightOptions = {
	readonly open: string;
	readonly close: string;
};

/** The text of `column` with every matched term wrapped in `open` and `close`. Only valid in a query with `match()`. */
export function highlight<TIndex extends AnyFts5Index>(index: TIndex & KeepsText<TIndex>, column: IndexedColumnKey<TIndex>, options: HighlightOptions): SQL<string> {
	const definition = definitionOf(index, 'highlight');
	assertHasText(definition, 'highlight');
	const position = columnPosition(definition, column, 'highlight');
	return sql<string>`highlight(${sql.identifier(definition.name)}, ${sql.raw(String(position))}, ${options.open}, ${options.close})`;
}

export type SnippetOptions = Partial<HighlightOptions> & {
	/** Put between fragments and at a cut start or end. Defaults to `…`. */
	readonly ellipsis?: string;
	/** The most tokens to return, from 1 to 64. Defaults to 16. */
	readonly tokens?: number;
};

/**
 * A short fragment of `column` around the matched terms, with them wrapped in `open` and `close` (empty by default).
 * Only valid in a query with `match()`.
 */
export function snippet<TIndex extends AnyFts5Index>(index: TIndex & KeepsText<TIndex>, column: IndexedColumnKey<TIndex>, options: SnippetOptions = {}): SQL<string> {
	const definition = definitionOf(index, 'snippet');
	assertHasText(definition, 'snippet');
	const position = columnPosition(definition, column, 'snippet');
	const tokens = options.tokens ?? 16;
	if (!Number.isInteger(tokens) || tokens < 1 || tokens > 64) {
		throw new TypeError(`snippet(): tokens must be a whole number from 1 to 64, got ${JSON.stringify(tokens)}`);
	}

	const {open = '', close = '', ellipsis = '…'} = options;
	return sql<string>`snippet(${sql.identifier(definition.name)}, ${sql.raw(String(position))}, ${open}, ${close}, ${ellipsis}, ${sql.raw(String(tokens))})`;
}
