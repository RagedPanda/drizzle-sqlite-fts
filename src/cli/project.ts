import {existsSync, globSync, readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import type {Casing} from '../columns.ts';

/** The parts of `drizzle.config.ts` that drizzle-sqlite-fts reads. */
export type ProjectConfig = {
	readonly schema: readonly string[];
	readonly out: string;
	readonly casing?: Casing;
};

export const configFileNames = ['drizzle.config.ts', 'drizzle.config.mts', 'drizzle.config.cts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs'];
const moduleExtensions = '{ts,mts,cts,js,mjs,cjs}';
/** The drizzle-kit dialects that talk to SQLite, where FTS5 lives. */
const sqliteDialects = ['sqlite', 'turso', 'd1-http'];

/** The config file drizzle-kit would use: `--config`, or the first `drizzle.config.*` in `cwd`. */
export function findConfigFile(cwd: string, requested: string | undefined): string {
	const candidates = requested === undefined ? configFileNames : [requested];
	const found = candidates.map(name => path.resolve(cwd, name)).find(file => existsSync(file));
	if (found === undefined) {
		throw new Error(`No drizzle config found: looked for ${candidates.join(', ')} in ${cwd}`);
	}

	return found;
}

/** Validates the loaded config module; `drizzle.config.ts` usually has `export default defineConfig({...})`. */
export function parseConfig(loaded: unknown): ProjectConfig {
	const module = loaded as {default?: unknown} | undefined;
	const config = (module?.default ?? module) as Record<string, unknown> | undefined;
	if (config === undefined || !sqliteDialects.includes(config['dialect'] as string)) {
		throw new Error(`drizzle-sqlite-fts supports the ${sqliteDialects.map(dialect => `'${dialect}'`).join(', ')} dialects only, got ${JSON.stringify(config?.['dialect'])}`);
	}

	const schema = config['schema'];
	const schemas = Array.isArray(schema) ? schema : [schema];
	if (schemas.length === 0 || schemas.some(entry => typeof entry !== 'string')) {
		throw new Error('The drizzle config needs a schema: a path, a glob, or a list of them');
	}

	const casing = config['casing'];
	if (casing !== undefined && casing !== 'snake_case' && casing !== 'camelCase') {
		throw new Error(`Unsupported casing ${JSON.stringify(casing)}`);
	}

	const out = typeof config['out'] === 'string' ? config['out'] : 'drizzle';
	return casing === undefined ? {schema: schemas, out} : {schema: schemas, out, casing};
}

/** The schema files, like drizzle-kit finds them: each entry is a file, a folder or a glob. */
export function schemaFiles(cwd: string, patterns: readonly string[]): string[] {
	const files = patterns.flatMap(pattern => {
		const resolved = path.resolve(cwd, pattern);
		const isFolder = existsSync(resolved) && statSync(resolved).isDirectory();
		return globSync(isFolder ? path.join(pattern, `**/*.${moduleExtensions}`) : pattern, {cwd});
	});
	return [...new Set(files.filter(file => !/\.d\.[cm]?ts$/.test(file)).map(file => path.resolve(cwd, file)))].toSorted();
}

/**
 * The migration files in the order drizzle's migrator applies them. Drizzle Kit 0.x lists them in
 * `meta/_journal.json`; 1.0 keeps one `<timestamp>_<name>/migration.sql` folder per migration, sorted by name.
 */
export function migrationFiles(outFolder: string): string[] {
	const journal = path.join(outFolder, 'meta', '_journal.json');
	if (existsSync(journal)) {
		const {entries} = JSON.parse(readFileSync(journal, 'utf8')) as {entries: {tag: string}[]};
		return entries.map(entry => path.join(outFolder, `${entry.tag}.sql`));
	}

	if (!existsSync(outFolder)) {
		return [];
	}

	return readdirSync(outFolder)
		.toSorted((left, right) => left.localeCompare(right))
		.map(entry => path.join(outFolder, entry, 'migration.sql'))
		.filter(file => existsSync(file));
}
