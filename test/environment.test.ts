import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {drizzleKitBin, environmentAliases, exitCode, nodeEnvironment, parseJsonc, tsconfigAliases} from '../src/cli/environment.ts';
import {temporaryProject} from './helpers.ts';

function fakeDrizzleKit(bin: unknown) {
	return {
		'node_modules/drizzle-kit/package.json': JSON.stringify({name: 'drizzle-kit', main: 'dist/index.js', bin}),
		'node_modules/drizzle-kit/dist/index.js': '',
		'node_modules/drizzle-kit/dist/package.json': JSON.stringify({type: 'commonjs'}),
	};
}

test('drizzleKitBin finds the bin from drizzle-kit\'s package.json', t => {
	const single = temporaryProject(t, fakeDrizzleKit('cli.js'));
	assert.equal(drizzleKitBin(single), path.join(single, 'node_modules/drizzle-kit/cli.js'));
	const named = temporaryProject(t, fakeDrizzleKit({'drizzle-kit': 'bin.cjs'}));
	assert.equal(drizzleKitBin(named), path.join(named, 'node_modules/drizzle-kit/bin.cjs'));
	const nested = temporaryProject(t, {
		'node_modules/drizzle-kit/package.json': JSON.stringify({name: 'drizzle-kit', main: 'lib/api/index.js', bin: 'cli.js'}),
		'node_modules/drizzle-kit/lib/api/index.js': '',
	});
	assert.equal(drizzleKitBin(nested), path.join(nested, 'node_modules/drizzle-kit/cli.js'));
	const none = temporaryProject(t, fakeDrizzleKit(undefined));
	assert.throws(() => drizzleKitBin(none), /has no drizzle-kit bin/);
});

test('nodeEnvironment imports TypeScript with extensionless imports and runs drizzle-kit', async t => {
	const cwd = temporaryProject(t, {
		'schema.ts': 'import {answer} from \'./answer\';\nexport const value: number = answer;\n',
		'answer.ts': 'export const answer = 42;\n',
	});
	const environment = nodeEnvironment(cwd);
	assert.equal(environment.cwd, cwd);
	assert.deepEqual({...await environment.importModule(path.join(cwd, 'schema.ts')) as object}, {value: 42});
	assert.equal(environment.runDrizzleKit(['--version']), 0);
	await environment.sleep(1);

	const written: string[] = [];
	t.mock.method(process.stdout, 'write', (text: string) => written.push(text));
	t.mock.method(process.stderr, 'write', (text: string) => written.push(text));
	environment.print('out');
	environment.printError('error');
	t.mock.restoreAll();
	assert.deepEqual(written, ['out\n', 'error\n']);
});

test('exitCode treats a missing status, from a killed process, as a failure', () => {
	assert.equal(exitCode(0), 0);
	assert.equal(exitCode(2), 2);
	assert.equal(exitCode(null), 1);
});

test('parseJsonc ignores comments and trailing commas, but not inside strings', () => {
	const text = '{\n\t// comment\n\t"a": "// kept", /* block */ "b": ["/* kept */", "\\"",],\n}';
	assert.deepEqual(parseJsonc(text), {a: '// kept', b: ['/* kept */', '"']});
});

test('tsconfigAliases maps tsconfig paths to jiti aliases', t => {
	assert.deepEqual(tsconfigAliases(temporaryProject(t)), {});
	assert.deepEqual(tsconfigAliases(temporaryProject(t, {'tsconfig.json': '{}'})), {});

	const cwd = temporaryProject(t, {
		'tsconfig.json': JSON.stringify({compilerOptions: {paths: {
			'@/*': ['./*'],
			'~lib': ['./src/lib.ts'],
			'none/*': [],
			'mid/*/x': ['./mid/*/x'],
			'star/*': ['./star'],
		}}}),
	});
	assert.deepEqual(tsconfigAliases(cwd), {'@/': path.join(cwd, '/'), '~lib': path.join(cwd, 'src/lib.ts')});
});

test('tsconfigAliases follows extends and resolves paths from baseUrl or the config that defines them', t => {
	const inherited = temporaryProject(t, {
		'tsconfig.json': JSON.stringify({extends: './config/base.json'}),
		'config/base.json': '{"compilerOptions": {"paths": {"@/*": ["../src/*"]}}}',
	});
	assert.deepEqual(tsconfigAliases(inherited), {'@/': path.join(inherited, 'src/')});

	const withBaseUrl = temporaryProject(t, {
		'tsconfig.json': JSON.stringify({extends: ['./config/base.json'], compilerOptions: {paths: {'#/*': ['*']}}}),
		'config/base.json': '{"compilerOptions": {"baseUrl": "../src"}}',
	});
	assert.deepEqual(tsconfigAliases(withBaseUrl), {'#/': path.join(withBaseUrl, 'src/')});

	const overridden = temporaryProject(t, {
		'tsconfig.json': JSON.stringify({extends: './base.json', compilerOptions: {baseUrl: '.'}}),
		'base.json': '{"compilerOptions": {}}',
	});
	assert.deepEqual(tsconfigAliases(overridden), {});
});

test('nodeEnvironment resolves imports through tsconfig paths', async t => {
	const cwd = temporaryProject(t, {
		'tsconfig.json': '{\n\t"compilerOptions": {\n\t\t// aliases\n\t\t"paths": {"@/*": ["./*"]},\n\t},\n}',
		'db/schema.ts': 'import {answer} from \'@/shared/answer\';\nexport const value: number = answer;\n',
		'shared/answer.ts': 'export const answer = 42;\n',
	});
	assert.deepEqual({...await nodeEnvironment(cwd).importModule(path.join(cwd, 'db/schema.ts')) as object}, {value: 42});
});

test('tsconfigAliases follows extends into packages', t => {
	const cwd = temporaryProject(t, {
		'tsconfig.json': JSON.stringify({extends: ['@scope/base', '@scope/base/paths.json']}),
		'node_modules/@scope/base/package.json': '{"name": "@scope/base", "main": "index.js"}',
		'node_modules/@scope/base/index.js': '',
		'node_modules/@scope/base/tsconfig.json': '{"compilerOptions": {"baseUrl": "."}}',
		'node_modules/@scope/base/paths.json': '{"compilerOptions": {"paths": {"#lib": ["lib.ts"]}}}',
	});
	assert.deepEqual(tsconfigAliases(cwd), {'#lib': path.join(cwd, 'node_modules/@scope/base/lib.ts')});
});

test('tsconfigAliases gives no aliases for a tsconfig it cannot read', t => {
	assert.deepEqual(tsconfigAliases(temporaryProject(t, {'tsconfig.json': '{"compilerOptions": {'})), {});
	assert.deepEqual(tsconfigAliases(temporaryProject(t, {'tsconfig.json': '{"extends": "missing-package"}'})), {});
});

test('environmentAliases reads JITI_ALIAS and ignores what is not JSON', () => {
	assert.deepEqual(environmentAliases(undefined), {});
	assert.deepEqual(environmentAliases('not json'), {});
	assert.deepEqual(environmentAliases('{"~x": "/x"}'), {'~x': '/x'});
});

test('nodeEnvironment keeps the aliases set in JITI_ALIAS', async t => {
	const cwd = temporaryProject(t, {
		'tsconfig.json': '{"compilerOptions": {"paths": {"@/*": ["./*"]}}}',
		'db/schema.ts': 'import {answer} from \'~shared/answer\';\nexport const value: number = answer;\n',
		'shared/answer.ts': 'export const answer = 42;\n',
	});
	const previous = process.env.JITI_ALIAS;
	process.env.JITI_ALIAS = JSON.stringify({'~shared': path.join(cwd, 'shared')});
	t.after(() => {
		if (previous === undefined) {
			delete process.env.JITI_ALIAS;
		} else {
			process.env.JITI_ALIAS = previous;
		}
	});
	assert.deepEqual({...await nodeEnvironment(cwd).importModule(path.join(cwd, 'db/schema.ts')) as object}, {value: 42});
});
