import * as path from 'path';
import * as vscode from 'vscode';

export interface ConflictItem {
	uri: string;
	name: string;
}

// Files whose last Sync hit a real conflict. Shown in the side panel until resolved.
export class ConflictStore {
	private readonly items = new Map<string, ConflictItem>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	add(uri: vscode.Uri) {
		this.items.set(uri.toString(), { uri: uri.toString(), name: vscode.workspace.asRelativePath(uri) || path.basename(uri.fsPath) });
		this.onDidChangeEmitter.fire();
	}

	remove(uri: vscode.Uri) {
		if (this.items.delete(uri.toString())) {
			this.onDidChangeEmitter.fire();
		}
	}

	has(uri: vscode.Uri): boolean {
		return this.items.has(uri.toString());
	}

	list(): ConflictItem[] {
		return [...this.items.values()];
	}

	dispose() {
		this.onDidChangeEmitter.dispose();
	}
}
