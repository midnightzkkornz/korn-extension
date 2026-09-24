import * as vscode from 'vscode';
import { RmdEditorProvider } from './rmdEditorProvider';
import { SyncViewProvider } from './syncViewProvider';

// View types a .r.md file can be switched between ('default' = plain text editor)
const VIEWS = {
	korn: RmdEditorProvider.viewType,
	text: 'default',
	preview: 'vscode.markdown.preview.editor',
	mdEditor: 'vscode.markdown.editor',
};

// Called once when the extension is activated
export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SyncViewProvider.viewId,
			new SyncViewProvider(context.extensionUri)
		),

		vscode.window.registerCustomEditorProvider(RmdEditorProvider.viewType, new RmdEditorProvider()),

		// Sync button (editor title bar + side panel). UI only for now.
		vscode.commands.registerCommand('korn.sync', (uri?: vscode.Uri) => {
			const target = activeUri(uri);
			const name = target ? vscode.workspace.asRelativePath(target) : 'workspace';
			vscode.window.showInformationMessage(`Sync: ยังไม่ได้ทำ logic (${name})`);
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

		// View switcher nav (editor title bar + Korn toolbar)
		vscode.commands.registerCommand('korn.openKorn', (uri?: vscode.Uri) => switchView(uri, VIEWS.korn)),
		vscode.commands.registerCommand('korn.openText', (uri?: vscode.Uri) => switchView(uri, VIEWS.text)),
		vscode.commands.registerCommand('korn.openPreview', (uri?: vscode.Uri) => switchView(uri, VIEWS.preview)),
		vscode.commands.registerCommand('korn.openMdEditor', (uri?: vscode.Uri) => switchView(uri, VIEWS.mdEditor))
	);
}

export function deactivate() {}

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
