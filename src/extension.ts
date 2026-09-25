import * as vscode from 'vscode';
import { SyncResult, syncFile } from './gitSync';
import { RmdEditorProvider } from './rmdEditorProvider';
import { SyncViewProvider } from './syncViewProvider';

// Called once when the extension is activated
export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SyncViewProvider.viewId,
			new SyncViewProvider(context.extensionUri)
		),

		vscode.window.registerCustomEditorProvider(RmdEditorProvider.viewType, new RmdEditorProvider(context.extensionUri)),

		// Sync button (Korn toolbar, editor title bar, side panel): add + commit + push this file
		vscode.commands.registerCommand('korn.sync', async (uri?: vscode.Uri): Promise<SyncResult | undefined> => {
			const target = activeUri(uri);
			if (!target || !target.path.endsWith('.r.md')) {
				vscode.window.showWarningMessage('เปิดไฟล์ .r.md ก่อนกด Sync');
				return undefined;
			}

			const name = vscode.workspace.asRelativePath(target);
			try {
				const result = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Sync ${name}…` },
					() => syncFile(target)
				);
				vscode.window.showInformationMessage(
					result.committed ? `Synced: ${result.message}` : `ไม่มีการเปลี่ยนแปลงใน ${name} — push แล้ว`
				);
				return result;
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				vscode.window
					.showErrorMessage(`Sync ${name} ไม่สำเร็จ: ${detail}`, 'Open Source Control')
					.then((choice) => choice && vscode.commands.executeCommand('workbench.view.scm'));
				throw error;
			}
		}),

		vscode.commands.registerCommand('korn.newFile', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showWarningMessage('เปิดโฟลเดอร์ก่อนสร้างไฟล์ .r.md');
				return;
			}

			const name = await vscode.window.showInputBox({
				prompt: 'ชื่อไฟล์ (ไม่ต้องใส่ .r.md)',
				placeHolder: 'notes',
				validateInput: (value) => (value.trim() ? undefined : 'กรุณาใส่ชื่อไฟล์'),
			});
			if (!name) {
				return;
			}

			const fileUri = vscode.Uri.joinPath(folder.uri, `${name.trim()}.r.md`);
			try {
				await vscode.workspace.fs.stat(fileUri);
				vscode.window.showWarningMessage(`มีไฟล์ ${name.trim()}.r.md อยู่แล้ว`);
			} catch {
				await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(`# ${name.trim()}\n\n`));
			}
			// vscode.open respects the default custom editor for *.r.md
			await vscode.commands.executeCommand('vscode.open', fileUri);
		}),

		// .r.md files always show in the Korn editor, even if another editor was picked
		vscode.window.tabGroups.onDidChangeTabs(() => ensureKornEditor()),

		// Back to the Korn editor from any other editor (editor title bar)
		vscode.commands.registerCommand('korn.openKorn', (uri?: vscode.Uri) => switchView(uri, RmdEditorProvider.viewType))
	);

	ensureKornEditor();
}

export function deactivate() {}

let switching = false;

// If the active tab is a .r.md opened in another editor (Text Editor, Markdown Preview, ...),
// reopen it in the Korn editor. Diff views are left alone.
async function ensureKornEditor() {
	if (switching) {
		return;
	}
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	const isOtherEditor =
		input instanceof vscode.TabInputText ||
		(input instanceof vscode.TabInputCustom && input.viewType !== RmdEditorProvider.viewType);
	if (!isOtherEditor || !input.uri.path.endsWith('.r.md')) {
		return;
	}

	switching = true;
	try {
		await switchView(input.uri, RmdEditorProvider.viewType);
	} finally {
		switching = false;
	}
}

function activeUri(uri?: vscode.Uri): vscode.Uri | undefined {
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
async function switchView(uri: vscode.Uri | undefined, viewType: string) {
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
