/** A table appearing or disappearing in a migration, by its lowercase name. */
export type TableEvent = {
	readonly kind: 'create' | 'drop';
	readonly table: string;
};

const identifier = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const qualified = String.raw`(?:${identifier}\s*\.\s*)?(${identifier})`;
const tableStatements = new RegExp([
	String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${qualified}`,
	String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${qualified}`,
	String.raw`\bALTER\s+TABLE\s+${qualified}\s+RENAME\s+TO\s+(${identifier})`,
].join('|'), 'gi');

/** Drops string literals and comments, so text inside them is never read as a statement. */
function withoutLiteralsAndComments(sql: string): string {
	return sql.replaceAll(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
}

/** `"we""ird"`, `` `notes` `` and `[notes]` become `we"ird` and `notes`, lowercased as SQLite compares them. */
export function unquote(name: string): string {
	const quote = name[0];
	const inner = quote === '"' || quote === '`'
		? name.slice(1, -1).replaceAll(quote + quote, quote)
		: quote === '[' ? name.slice(1, -1) : name;
	return inner.toLowerCase();
}

/**
 * The tables a migration creates and drops, in statement order. A rename drops the old name and creates the new one,
 * which is how drizzle-kit's `__new_<table>` rebuild ends: the original table and its triggers are gone,
 * and a table with the same name but no triggers takes its place.
 */
export function tableEvents(sql: string): TableEvent[] {
	return [...withoutLiteralsAndComments(sql).matchAll(tableStatements)].flatMap((match): TableEvent[] => {
		const [, created, dropped, renamedFrom, renamedTo] = match;
		if (created !== undefined) {
			return [{kind: 'create', table: unquote(created)}];
		}

		if (dropped !== undefined) {
			return [{kind: 'drop', table: unquote(dropped)}];
		}

		return [{kind: 'drop', table: unquote(renamedFrom!)}, {kind: 'create', table: unquote(renamedTo!)}];
	});
}

/** Whether `table` exists after the given migrations' events: its last event is a create. */
export function tableExists(events: readonly (readonly TableEvent[])[], table: string): boolean {
	const key = table.toLowerCase();
	return events.flat().findLast(event => event.table === key)?.kind === 'create';
}

/** Whether any migration after position `after` drops `table`, which takes its triggers with it. */
export function droppedSince(events: readonly (readonly TableEvent[])[], table: string, after: number): boolean {
	const key = table.toLowerCase();
	return events.slice(after + 1).some(migration => migration.some(event => event.kind === 'drop' && event.table === key));
}
