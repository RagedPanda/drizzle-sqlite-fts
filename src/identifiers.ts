/** Throws unless `value` is a non-empty string; `label` names it in the error. */
export function assertName(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new TypeError(`${label} must be a non-empty string, got ${JSON.stringify(value)}`);
	}
}
