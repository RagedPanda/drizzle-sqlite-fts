import {assertColumnNames} from './declare.ts';
import type {Marker} from './migration.ts';
import {copyStandaloneSql, createSql, createTriggersSql, dropIndexSql, rebuildSql} from './render.ts';
import type {IndexSpec} from './spec.ts';
import {nameKey, recordedIndexes, sameSpec, type RecordedIndex, type StateConflict} from './state.ts';
import {droppedSince, tableEvents, tableExists, type TableEvent} from './table-events.ts';

/** What the next migration must do: its statements and marker, a line per change for the CLI, and the changes it refuses. */
export type MigrationPlan = {
	readonly statements: readonly string[];
	readonly marker: Marker;
	readonly changes: readonly string[];
	readonly refusals: readonly string[];
};

export type PlanOptions = {
	/** Allow a change that recreates a contentless or standalone index without its rows. */
	readonly allowDataLoss?: boolean;
};

type Step = {
	readonly statements: readonly string[];
	readonly change?: string;
	readonly refusal?: string;
	/** The spec to record, when the step leaves the index created or repaired. */
	readonly set?: IndexSpec;
};

const noStep: Step = {statements: []};

/** Throws when two declarations share a name, or casing gave one index two columns with the same database name. */
function assertDeclarations(declared: readonly IndexSpec[]): void {
	const names = new Set<string>();
	for (const spec of declared) {
		if (names.has(nameKey(spec.name))) {
			throw new TypeError(`Two fts5() declarations are named "${spec.name}"; rename one of them`);
		}

		names.add(nameKey(spec.name));
		assertColumnNames(spec.name, spec.columns);
	}
}

function missingTableRefusal(spec: IndexSpec, table: string): string {
	return `"${spec.name}" indexes "${table}", which no earlier migration creates. Run drizzle-kit generate first, then run this again.`;
}

function createStep(spec: IndexSpec, events: readonly TableEvent[][]): Step {
	if (spec.content !== undefined && !tableExists(events, spec.content.table)) {
		return {statements: [], refusal: missingTableRefusal(spec, spec.content.table)};
	}

	return {statements: createSql(spec), change: `create ${spec.name}`, set: spec};
}

/** A content table rebuilt or dropped by a later drizzle-kit migration lost its triggers; put them back and refill the index. */
function repairStep(recorded: RecordedIndex, events: readonly TableEvent[][]): Step {
	const {spec} = recorded;
	if (spec.content === undefined || !droppedSince(events, spec.content.table, recorded.migration)) {
		return noStep;
	}

	if (!tableExists(events, spec.content.table)) {
		return {statements: [], refusal: missingTableRefusal(spec, spec.content.table)};
	}

	return {
		statements: [...createTriggersSql(spec), rebuildSql(spec)],
		change: `restore the triggers of ${spec.name} and rebuild it, because a migration rebuilt "${spec.content.table}"`,
		set: spec,
	};
}

function replaceStep(previous: IndexSpec, next: IndexSpec, events: readonly TableEvent[][], options: PlanOptions): Step {
	if (next.content !== undefined && !tableExists(events, next.content.table)) {
		return {statements: [], refusal: missingTableRefusal(next, next.content.table)};
	}

	if (previous.mode === 'standalone' && next.mode === 'standalone') {
		return {statements: copyStandaloneSql(previous, next), change: `recreate ${next.name}, copying its rows`, set: next};
	}

	if (previous.mode !== 'external' && options.allowDataLoss !== true) {
		return {
			statements: [],
			refusal: `Changing "${previous.name}" recreates it empty, because a ${previous.mode} index can't be refilled from a table. Pass --allow-data-loss to do it anyway.`,
		};
	}

	const refill = next.content === undefined ? '' : ', refilling it from its table';
	return {statements: [...dropIndexSql(previous), ...createSql(next)], change: `recreate ${next.name}${refill}`, set: next};
}

function declaredStep(spec: IndexSpec, recorded: RecordedIndex | undefined, events: readonly TableEvent[][], options: PlanOptions): Step {
	if (recorded === undefined) {
		return createStep(spec, events);
	}

	return sameSpec(recorded.spec, spec) ? repairStep(recorded, events) : replaceStep(recorded.spec, spec, events, options);
}

function conflictRefusal({name, kind}: StateConflict): string {
	return kind === 'created twice'
		? `Two migrations create "${name}" with different settings, and the database keeps whichever ran first. Delete the later migration that creates it, then run this again.`
		: `A migration changes "${name}" after an earlier one dropped it, so it fails when it runs. Delete the migration that changes it, then run this again.`;
}

/**
 * Compares the declared indexes with what the migrations recorded, and plans the migration that brings the database
 * from one to the other. Removed indexes are dropped first, then the others are created, recreated or repaired.
 */
export function planMigration(declared: readonly IndexSpec[], migrations: readonly string[], options: PlanOptions = {}): MigrationPlan {
	assertDeclarations(declared);
	const {indexes: recorded, conflicts} = recordedIndexes(migrations);
	if (conflicts.length > 0) {
		return {statements: [], marker: {version: 1, set: [], created: [], drop: []}, changes: [], refusals: conflicts.map(conflictRefusal)};
	}

	const events = migrations.map(tableEvents);
	const declaredNames = new Set(declared.map(spec => nameKey(spec.name)));
	const removed = [...recorded.entries()].filter(([key]) => !declaredNames.has(key)).map(([, {spec}]) => spec);
	const steps = declared.map(spec => declaredStep(spec, recorded.get(nameKey(spec.name)), events, options));
	const refusals = steps.flatMap(step => step.refusal === undefined ? [] : [step.refusal]);
	const set = steps.flatMap(step => step.set === undefined ? [] : [step.set]);
	return {
		statements: [...removed.flatMap(dropIndexSql), ...steps.flatMap(step => step.statements)],
		marker: {
			version: 1,
			set,
			created: set.filter(spec => !recorded.has(nameKey(spec.name))).map(spec => spec.name),
			drop: removed.map(spec => spec.name),
		},
		changes: [...removed.map(spec => `drop ${spec.name}`), ...steps.flatMap(step => step.change === undefined ? [] : [step.change])],
		refusals,
	};
}
