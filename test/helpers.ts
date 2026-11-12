import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {TestContext} from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

/**
 * A temporary project folder inside the repository, so modules imported from it resolve
 * this repository's drizzle-orm and drizzle-kit. Removed when the test ends.
 */
export function temporaryProject(context: TestContext, files: Readonly<Record<string, string>> = {}): string {
	const parent = path.join(repositoryRoot, '.tmp');
	mkdirSync(parent, {recursive: true});
	const folder = mkdtempSync(path.join(parent, 'project-'));
	context.after(() => rmSync(folder, {recursive: true, force: true}));
	for (const [name, contents] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(folder, name)), {recursive: true});
		writeFileSync(path.join(folder, name), contents);
	}

	return folder;
}

export const sourceIndex = path.join(repositoryRoot, 'src', 'index.ts');
