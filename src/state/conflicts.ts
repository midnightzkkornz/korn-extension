import * as path from 'path';
import * as vscode from 'vscode';

import type { ConflictItem } from '../shared/protocol';
export type { ConflictItem };

// Files whose last Sync hit a real conflict. Shown in the side panel until resolved.
export class ConflictStore {
	private readonly items = new Map<string, ConflictItem>();
	private readonly busyFiles = new Set<string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	add(uri: vscode.Uri, resolving = false) {
		const key = uri.toString();
		this.items.set(key, {
			uri: key,
			name: vscode.workspace.asRelativePath(uri) || path.basename(uri.fsPath),
			busy: this.busyFiles.has(key),
			resolving,
		});
		this.onDidChangeEmitter.fire();
	}

	remove(uri: vscode.Uri) {
		if (this.items.delete(uri.toString())) {
			this.onDidChangeEmitter.fire();
		}
	}

	/** Forget the conflicts of one repo (they belonged to the branch that was just switched away from) */
	clearRepo(root: string) {
		const prefix = root.endsWith(path.sep) ? root : root + path.sep;
		let changed = false;
		for (const [key, item] of this.items) {
			if (vscode.Uri.parse(item.uri).fsPath.startsWith(prefix)) {
				this.items.delete(key);
				changed = true;
			}
		}
		if (changed) {
			this.onDidChangeEmitter.fire();
		}
	}

	has(uri: vscode.Uri): boolean {
		return this.items.has(uri.toString());
	}

	list(): ConflictItem[] {
		return [...this.items.values()];
	}

	isBusy(uri: vscode.Uri): boolean {
		return this.busyFiles.has(uri.toString());
	}

	// Runs `work` as the only Sync/conflict action for this file; returns undefined if one is already running
	async runExclusive<T>(uri: vscode.Uri, work: () => PromiseLike<T>): Promise<{ value: T } | undefined> {
		const key = uri.toString();
		if (this.busyFiles.has(key)) {
			return undefined;
		}
		this.setBusy(key, true);
		try {
			return { value: await work() };
		} finally {
			this.setBusy(key, false);
		}
	}

	private setBusy(key: string, busy: boolean) {
		if (busy) {
			this.busyFiles.add(key);
		} else {
			this.busyFiles.delete(key);
		}
		const item = this.items.get(key);
		if (item) {
			item.busy = busy;
			this.onDidChangeEmitter.fire();
		}
	}

	dispose() {
		this.onDidChangeEmitter.dispose();
	}
}
