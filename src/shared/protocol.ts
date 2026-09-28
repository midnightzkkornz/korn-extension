// Messages between the extension and its webviews. Imported by both sides
// (src/ and webview/), so it must not import 'vscode' or anything from node.

// ---- Conflicts ----

// cancel = undo "Resolve in Korn" and go back to choosing
export type ConflictAction = 'keepMine' | 'saveCopy' | 'resolve' | 'cancel';

export interface ConflictItem {
	uri: string;
	name: string;
	busy: boolean; // an action is running for this file: other choices wait
	resolving: boolean; // "Resolve in Korn" started (merge in progress)
}

// ---- Files in the side panel ----

// dirty = changed, not synced · ahead = committed, not pushed · synced · never = never synced
// conflict · blocked = committed, can't be pushed until a conflict in the same repo is handled
// incoming = unchanged here, the remote has a newer version · nogit = not in a git repo
export type FileRowState = 'dirty' | 'ahead' | 'synced' | 'never' | 'conflict' | 'blocked' | 'incoming' | 'nogit';

export interface FileRow {
	uri: string;
	name: string;
	root?: string; // git repo root
	state: FileRowState;
	lastSync?: string; // ISO time
	blockedBy?: string; // the conflicted file holding this one back
	incoming: boolean; // remote has a newer version (also set on dirty/ahead files)
	unsaved: boolean; // open in an editor with changes not saved yet
	busy: boolean;
}

// ---- Side panel (webview/panel) ----

export type HostToPanel =
	| { type: 'conflicts'; items: ConflictItem[] }
	| { type: 'files'; files: FileRow[]; autoSync: string };

export type PanelToHost =
	| { type: 'ready' }
	| { type: 'syncAll' }
	| { type: 'syncFile'; uri: string }
	| { type: 'open'; uri: string }
	| { type: 'openSettings' }
	| { type: 'showLog' }
	| { type: 'resolve'; uri: string; action: ConflictAction };
