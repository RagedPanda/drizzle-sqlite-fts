import {readMarker} from './migration.ts';
import type {IndexSpec} from './spec.ts';

/** An index the migrations have created, and the position of the last migration that created or repaired it. */
export type RecordedIndex = {
	readonly spec: IndexSpec;
	readonly migration: number;
};

/**
 * Two migrations, usually from branches merged together, that disagree about an index: one creates an index another
 * already created with other settings, or one changes or repairs an index another dropped.
 */
export type StateConflict = {
	readonly name: string;
	readonly kind: 'created twice' | 'changed after drop';
};

export type RecordedState = {
	readonly indexes: ReadonlyMap<string, RecordedIndex>;
	readonly conflicts: readonly StateConflict[];
};

/** SQLite compares names case-insensitively, so state is keyed by the lowercase name. */
export const nameKey = (name: string): string => name.toLowerCase();

/** Two specs are the same index when their JSON matches with keys in any order and names in any letter case. */
export function sameSpec(left: IndexSpec, right: IndexSpec): boolean {
	const canonical = (spec: IndexSpec) => JSON.stringify({...spec, name: nameKey(spec.name)}, Object.keys(spec).concat(['table', 'rowid']).sort());
	return canonical(left) === canonical(right);
}

/** The conflict, if any, of recording `spec` from a migration that `created` it over what earlier migrations recorded. */
function conflictOf(spec: IndexSpec, created: boolean, recorded: RecordedIndex | undefined): StateConflict | undefined {
	if (created && recorded !== undefined && !sameSpec(recorded.spec, spec)) {
		return {name: spec.name, kind: 'created twice'};
	}

	return !created && recorded === undefined ? {name: spec.name, kind: 'changed after drop'} : undefined;
}

/**
 * The indexes the migrations leave behind, folded over every marker in migration order.
 * Later markers win for the same index and a drop removes it. When two migrations disagree, the database keeps what
 * the first one did, so that is what's recorded, along with the conflict.
 */
export function recordedIndexes(migrations: readonly string[]): RecordedState {
	return migrations.reduce<RecordedState>((state, migration, position) => {
		const marker = readMarker(migration);
		if (marker === undefined) {
			return state;
		}

		const indexes = new Map(state.indexes);
		for (const name of marker.drop) {
			indexes.delete(nameKey(name));
		}

		const created = new Set(marker.created.map(nameKey));
		const conflicts = [...state.conflicts];
		for (const spec of marker.set) {
			const conflict = conflictOf(spec, created.has(nameKey(spec.name)), indexes.get(nameKey(spec.name)));
			if (conflict === undefined) {
				indexes.set(nameKey(spec.name), {spec, migration: position});
			} else {
				conflicts.push(conflict);
			}
		}

		return {indexes, conflicts};
	}, {indexes: new Map(), conflicts: []});
}
