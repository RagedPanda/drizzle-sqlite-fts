import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {getFts5Definition, type Fts5Definition} from '../declare.ts';
import {planMigration, type MigrationPlan} from '../diff.ts';
import {renderMigration} from '../migration.ts';
import {createSql} from '../render.ts';
import {toIndexSpec, type IndexSpec} from '../spec.ts';
import {findConfigFile, migrationFiles, parseConfig, schemaFiles, type ProjectConfig} from './project.ts';

/** Everything the CLI does outside this module, so tests can replace it. */
export type CliEnvironment = {
	readonly cwd: string;
	readonly print: (text: string) => void;
	readonly printError: (text: string) => void;
	/** Imports a TypeScript or JavaScript module the way drizzle-kit does. */
	readonly importModule: (file: string) => Promise<unknown>;
	/** Runs drizzle-kit with `args` and returns its exit code. */
	readonly runDrizzleKit: (args: readonly string[]) => number;
	readonly sleep: (milliseconds: number) => Promise<void>;
};

export const usage = `Usage: drizzle-sqlite-fts <command> [options]

Commands:
  generate   Write a migration for the FTS5 indexes that changed
  check      Exit with 1 when an index changed without a migration for it
  sql        Print SQL that creates every index, its triggers and its contents

Options:
  -c, --config <file>  The drizzle-kit config, by default drizzle.config.ts
  --name <name>        The migration name for generate, by default "fts"
  --allow-data-loss    Let generate recreate a contentless or standalone index empty
  -h, --help           Show this help

Exit codes: 0 done, 1 changes pending or an error, 2 a change was refused.
`;

/** The exit code for a change that needs the user's action first, so scripts can tell it from a failure. */
const refusedCode = 2;

type Project = {
	readonly configFile: string;
	readonly config: ProjectConfig;
	readonly indexes: readonly IndexSpec[];
};

/** The fts5() declarations among a schema module's exports, once each even when exported twice. */
export function collectDefinitions(modules: readonly Record<string, unknown>[]): Fts5Definition[] {
	const definitions = modules.flatMap(module => Object.values(module).map(getFts5Definition));
	return [...new Set(definitions.filter(definition => definition !== undefined))];
}

async function loadProject(environment: CliEnvironment, requestedConfig: string | undefined): Promise<Project> {
	const configFile = findConfigFile(environment.cwd, requestedConfig);
	const config = parseConfig(await environment.importModule(configFile));
	const files = schemaFiles(environment.cwd, config.schema);
	if (files.length === 0) {
		throw new Error(`No schema files match ${config.schema.join(', ')}`);
	}

	const modules: Record<string, unknown>[] = [];
	for (const file of files) {
		modules.push(await environment.importModule(file) as Record<string, unknown>);
	}

	return {configFile, config, indexes: collectDefinitions(modules).map(definition => toIndexSpec(definition, config.casing))};
}

function plan(environment: CliEnvironment, project: Project, allowDataLoss: boolean): MigrationPlan {
	const files = migrationFiles(path.resolve(environment.cwd, project.config.out));
	return planMigration(project.indexes, files.map(file => readFileSync(file, 'utf8')), {allowDataLoss});
}

const bullets = (lines: readonly string[]) => lines.map(line => `  - ${line}`).join('\n');

function printRefusals(environment: CliEnvironment, refusals: readonly string[]): number {
	environment.printError(`Nothing was written, because:\n${bullets(refusals)}`);
	return refusedCode;
}

/** The migration file drizzle-kit just created, if it is the last one the migrator will apply. */
function createdMigration(before: readonly string[], after: readonly string[]): {file: string; isLast: boolean} {
	const created = after.filter(file => !before.includes(file));
	if (created.length !== 1) {
		throw new Error(`Expected drizzle-kit to create one migration, found ${created.length}`);
	}

	const [file] = created as [string];
	return {file, isLast: after.at(-1) === file};
}

// Drizzle Kit 1.0 names migration folders by the second, and the migrator sorts them by name, so ours can
// land in the same second as the schema migration before it and sort first. Then try again a second later.
const attempts = 3;

async function generate(environment: CliEnvironment, project: Project, name: string, allowDataLoss: boolean): Promise<number> {
	const {statements, marker, changes, refusals} = plan(environment, project, allowDataLoss);
	if (refusals.length > 0) {
		return printRefusals(environment, refusals);
	}

	if (statements.length === 0) {
		environment.print('No FTS5 index changes, nothing to generate.');
		return 0;
	}

	const outFolder = path.resolve(environment.cwd, project.config.out);
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const before = migrationFiles(outFolder);
		const status = environment.runDrizzleKit(['generate', '--custom', `--name=${name}`, `--config=${project.configFile}`]);
		if (status !== 0) {
			environment.printError(`drizzle-kit generate --custom failed with exit code ${status}`);
			return status;
		}

		const {file, isLast} = createdMigration(before, migrationFiles(outFolder));
		if (isLast) {
			writeFileSync(file, renderMigration(statements, marker));
			environment.print(`Wrote ${path.relative(environment.cwd, file)}:\n${bullets(changes)}`);
			return 0;
		}

		rmSync(path.dirname(file), {recursive: true, force: true});
		await environment.sleep(1000);
	}

	environment.printError(`Could not create a migration that sorts after the existing ones in ${attempts} attempts`);
	return 1;
}

function check(environment: CliEnvironment, project: Project): number {
	const {statements, changes, refusals} = plan(environment, project, false);
	if (refusals.length > 0) {
		return printRefusals(environment, refusals);
	}

	if (statements.length === 0) {
		environment.print('FTS5 indexes match the migrations.');
		return 0;
	}

	environment.printError(`FTS5 indexes changed without a migration. Run drizzle-sqlite-fts generate to:\n${bullets(changes)}`);
	return 1;
}

/** Runs the CLI with `argv` (without the node and script paths) and returns the exit code. */
export async function runCli(argv: readonly string[], environment: CliEnvironment): Promise<number> {
	try {
		const {values, positionals} = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				config: {type: 'string', short: 'c'},
				name: {type: 'string', default: 'fts'},
				'allow-data-loss': {type: 'boolean', default: false},
				help: {type: 'boolean', short: 'h'},
			},
		});
		const [command] = positionals;
		if (values.help === true || command === undefined) {
			environment.print(usage);
			return command === undefined && values.help !== true ? 1 : 0;
		}

		if (!['generate', 'check', 'sql'].includes(command)) {
			environment.printError(`Unknown command ${command}\n\n${usage}`);
			return 1;
		}

		const project = await loadProject(environment, values.config);
		if (command === 'sql') {
			environment.print(project.indexes.flatMap(createSql).join('\n\n'));
			return 0;
		}

		return command === 'check' ? check(environment, project) : await generate(environment, project, values.name, values['allow-data-loss']);
	} catch (error) {
		environment.printError(`drizzle-sqlite-fts: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
