/** Throws unless `value` is a non-empty string; `label` names it in the error. */
export function assertName(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new TypeError(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
	}
}

/** Quotes an SQLite identifier: `user name` becomes `"user name"`, and inner quotes are doubled. */
export function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

/** Quotes an SQLite string literal: `it's` becomes `'it''s'`. */
export function quoteLiteral(value: string): string {
	return `'${value.replaceAll('\'', '\'\'')}'`;
}
