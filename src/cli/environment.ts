import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {createJiti} from 'jiti';
import type {CliEnvironment} from './run.ts';

type Manifest = {name?: string; bin?: string | Record<string, string>};

type TsConfig = {extends?: string | string[]; compilerOptions?: {baseUrl?: string; paths?: Record<string, string[]>}};

type PathsConfig = {baseUrl?: string; paths?: Record<string, string[]>; pathsFolder?: string};

/** The path of drizzle-kit's CLI script, installed in the project at `cwd`. */
export function drizzleKitBin(cwd: string): string {
	// drizzle-kit does not export its package.json, so walk up from its entry point to find it.
	let folder = path.dirname(createRequire(path.join(cwd, 'package.json')).resolve('drizzle-kit'));
	const readManifest = (): Manifest => {
		const file = path.join(folder, 'package.json');
		return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Manifest : {};
	};

	let manifest = readManifest();
	while (manifest.name !== 'drizzle-kit') {
		folder = path.dirname(folder);
		manifest = readManifest();
	}

	const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['drizzle-kit'];
	if (bin === undefined) {
		throw new Error(`drizzle-kit in ${folder} has no drizzle-kit bin`);
	}

	return path.resolve(folder, bin);
}

/** A process killed by a signal has no exit status; report it as a failure. */
export function exitCode(status: number | null): number {
	return status ?? 1;
}

/** Parse tsconfig's JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
	const strings = /"(?:\\.|[^"\\])*"/.source;
	const withoutComments = text.replaceAll(new RegExp(`${strings}|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, 'g'), match => match.startsWith('"') ? match : '');
	return JSON.parse(withoutComments.replaceAll(new RegExp(`${strings}|,(\\s*[}\\]])`, 'g'), (match, close?: string) => close ?? match));
}

/** The file an `extends` entry names: a relative path, a package's tsconfig.json, or a file inside a package. */
function resolveExtends(file: string, parent: string): string {
	const require = createRequire(file);
	if (parent.startsWith('.') || path.isAbsolute(parent)) {
		return require.resolve(parent);
	}

	try {
		return require.resolve(`${parent}/tsconfig.json`);
	} catch {
		return require.resolve(parent);
	}
}

function readPathsConfig(file: string): PathsConfig {
	const config = parseJsonc(readFileSync(file, 'utf8')) as TsConfig;
	const folder = path.dirname(file);
	const parents = config.extends === undefined ? [] : [config.extends].flat();
	const resolved: PathsConfig = {};
	for (const parent of parents) {
		Object.assign(resolved, readPathsConfig(resolveExtends(file, parent)));
	}

	const {baseUrl, paths} = config.compilerOptions ?? {};
	if (baseUrl !== undefined) {
		resolved.baseUrl = path.resolve(folder, baseUrl);
	}

	if (paths !== undefined) {
		resolved.paths = paths;
		resolved.pathsFolder = folder;
	}

	return resolved;
}

function readPathsConfigOrEmpty(file: string): PathsConfig {
	try {
		return readPathsConfig(file);
	} catch {
		return {};
	}
}

/**
 * jiti aliases for the `paths` in the project's tsconfig.json, which drizzle-kit honors and jiti ignores.
 * Only the first target of each path is used, and patterns with a `*` anywhere but the end are skipped.
 * A tsconfig that can't be read or resolved gives no aliases rather than stopping the command.
 */
export function tsconfigAliases(cwd: string): Record<string, string> {
	const file = path.join(cwd, 'tsconfig.json');
	if (!existsSync(file)) {
		return {};
	}

	const {baseUrl, paths = {}, pathsFolder} = readPathsConfigOrEmpty(file);
	const base = baseUrl ?? pathsFolder ?? cwd;
	const aliases: Record<string, string> = {};
	for (const [pattern, [target]] of Object.entries(paths)) {
		if (target === undefined) {
			continue;
		}

		if (!pattern.includes('*') && !target.includes('*')) {
			aliases[pattern] = path.resolve(base, target);
		} else if (pattern.indexOf('*') === pattern.length - 1 && target.indexOf('*') === target.length - 1) {
			aliases[pattern.slice(0, -1)] = path.join(path.resolve(base, target.slice(0, -1)), '/');
		}
	}

	return aliases;
}

/** The aliases set in `JITI_ALIAS`, which jiti ignores once an `alias` option is passed. */
export function environmentAliases(json: string | undefined): Record<string, string> {
	if (json === undefined) {
		return {};
	}

	try {
		return JSON.parse(json) as Record<string, string>;
	} catch {
		return {};
	}
}

/** The real environment: jiti loads TypeScript schema files with the same import rules as drizzle-kit. */
export function nodeEnvironment(cwd: string): CliEnvironment {
	const alias = {...tsconfigAliases(cwd), ...environmentAliases(process.env.JITI_ALIAS)};
	const jiti = createJiti(pathToFileURL(path.join(cwd, 'index.js')).href, {interopDefault: false, alias});
	return {
		cwd,
		print: text => process.stdout.write(`${text}\n`),
		printError: text => process.stderr.write(`${text}\n`),
		importModule: file => jiti.import(file),
		runDrizzleKit: args => exitCode(spawnSync(process.execPath, [drizzleKitBin(cwd), ...args], {cwd, stdio: 'inherit'}).status),
		sleep: milliseconds => setTimeout(milliseconds),
	};
}
