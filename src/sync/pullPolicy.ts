// Decides whether auto-sync may pull a repo now (no vscode import: unit-tested with node)

export interface PullRow {
	name: string;
	state: string; // FileRowState
	incoming: boolean;
	unsaved: boolean; // open in an editor with changes not saved yet
	busy: boolean;
}

export type PullDecision =
	| { pull: false; reason: 'nothing new' }
	| { pull: false; reason: 'conflict' | 'blocked' | 'unsaved' | 'busy'; file: string }
	| { pull: true };

export function decidePull(rows: PullRow[]): PullDecision {
	const incoming = rows.filter((r) => r.incoming);
	if (incoming.length === 0) {
		return { pull: false, reason: 'nothing new' };
	}
	const conflict = rows.find((r) => r.state === 'conflict' || r.state === 'blocked');
	if (conflict) {
		return { pull: false, reason: conflict.state === 'conflict' ? 'conflict' : 'blocked', file: conflict.name };
	}
	// Pulling would change a file under someone's cursor: wait for the save (its Sync merges then)
	const unsaved = incoming.find((r) => r.unsaved);
	if (unsaved) {
		return { pull: false, reason: 'unsaved', file: unsaved.name };
	}
	const busy = rows.find((r) => r.busy);
	if (busy) {
		return { pull: false, reason: 'busy', file: busy.name }; // retried a few seconds later
	}
	return { pull: true };
}
