#!/usr/bin/env node
import {nodeEnvironment} from './environment.ts';
import {runCli} from './run.ts';

void runCli(process.argv.slice(2), nodeEnvironment(process.cwd())).then(code => {
	process.exitCode = code;
});
