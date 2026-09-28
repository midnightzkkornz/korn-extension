import * as vscode from 'vscode';
import { getMergeState } from '../git/sync';
import { RmdEditorProvider } from '../views/editorProvider';

// Which editor a .r.md opens in, and switching between them

export function activeUri(uri?: vscode.Uri): vscode.Uri | undefined {
	if (uri) {
		return uri;
	}
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	return undefined;
}

// Reopen the file with another editor in the same tab, like "Reopen Editor With..."
export async function switchView(uri: vscode.Uri | undefined, viewType: string) {
	const target = activeUri(uri);
	if (!target) {
		return;
	}

	const group = vscode.window.tabGroups.activeTabGroup;
	const oldTab = group.activeTab;
	const oldInput = oldTab?.input;
	const oldView =
		oldInput instanceof vscode.TabInputCustom ? oldInput.viewType : oldInput instanceof vscode.TabInputText ? 'default' : undefined;
	const sameFile =
		(oldInput instanceof vscode.TabInputText || oldInput instanceof vscode.TabInputCustom) &&
		oldInput.uri.toString() === target.toString();

	if (sameFile && oldView === viewType) {
		return; // already in this view
	}

	await vscode.commands.executeCommand('vscode.openWith', target, viewType, group.viewColumn);

	if (oldTab && sameFile) {
		await vscode.window.tabGroups.close(oldTab, true);
	}
}

let switching = false;

// The active .r.md tab should be in the Korn editor (its Resolve mode handles conflicts).
// Exception: while the file still has conflict markers, VS Code's Text Editor may stay open if the user
// chose "Open in VS Code editor". Diff and merge editors are left alone.
export async function ensureRightEditor() {
	if (switching) {
		return;
	}
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (!(input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) || !input.uri.path.endsWith('.r.md')) {
		return;
	}
	const current = input instanceof vscode.TabInputCustom ? input.viewType : 'default';

	switching = true;
	try {
		if (current === RmdEditorProvider.viewType) {
			return;
		}
		if (current === 'default' && (await getMergeState(input.uri)) === 'unresolved') {
			return;
		}
		await switchView(input.uri, RmdEditorProvider.viewType);
	} finally {
		switching = false;
	}
}

export function registerEditorCommands(): vscode.Disposable[] {
	return [
		// .r.md files always show in the Korn editor (VS Code's Text Editor only while fixing a conflict)
		vscode.window.tabGroups.onDidChangeTabs(() => ensureRightEditor()),
		// After Accept … + Cmd+S the markers are gone: go back to the Korn editor
		vscode.workspace.onDidSaveTextDocument((d) => d.uri.path.endsWith('.r.md') && ensureRightEditor()),

		// "Open in VS Code editor" from the Resolve mode (VS Code's Accept Current / Incoming / Both)
		vscode.commands.registerCommand('korn.openTextEditor', (uri: vscode.Uri) => switchView(uri, 'default')),

		// Back to the Korn editor from any other editor (editor title bar)
		vscode.commands.registerCommand('korn.openKorn', (uri?: vscode.Uri) => switchView(uri, RmdEditorProvider.viewType)),
	];
}
