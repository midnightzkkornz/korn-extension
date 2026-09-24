import * as vscode from 'vscode';
import { RmdEditorProvider } from './rmdEditorProvider';
import { SyncViewProvider } from './syncViewProvider';

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
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
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

		vscode.commands.registerCommand('korn.openPreview', (uri?: vscode.Uri) => {
			const target = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (target) {
				vscode.commands.executeCommand('vscode.openWith', target, RmdEditorProvider.viewType);
			}
		})
	);
}

export function deactivate() {}
