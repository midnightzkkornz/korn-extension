import * as path from 'path';
import * as vscode from 'vscode';
import { formatDate } from '../git/ops';
import { RmdEditorProvider } from '../views/editorProvider';

// Commands behind the keyboard shortcuts in package.json (contributes.keybindings)

const MODES = [
	{ mode: 'view', label: 'View', detail: 'Rendered markdown' },
	{ mode: 'text', label: 'Text', detail: 'Markdown source' },
	{ mode: 'preview', label: 'Preview', detail: 'Source + live preview' },
	{ mode: 'editor', label: 'Editor', detail: 'WYSIWYG' },
];

// korn.showMode: switch the Korn tab to View / Text / Preview / Editor ("next" cycles through them).
// Without an argument (Command Palette) it asks which one.
async function showMode(mode?: string) {
	if (!mode) {
		const picked = await vscode.window.showQuickPick(MODES, { placeHolder: 'Show this .r.md as…' });
		if (!picked) {
			return;
		}
		mode = picked.mode;
	}
	if (!RmdEditorProvider.postToActive({ type: 'setMode', mode })) {
		vscode.window.showInformationMessage('เปิดไฟล์ .r.md ในหน้า Korn ก่อน');
	}
}

// korn.insertDateTime: type "YYYY-MM-DD HH:mm" at the cursor (same format as the sync commits)
async function insertDateTime() {
	const text = formatDate(new Date());
	const editor = vscode.window.activeTextEditor;
	if (editor && editor.document.uri.path.endsWith('.r.md')) {
		await editor.edit((edit) => {
			for (const selection of editor.selections) {
				edit.replace(selection, text);
			}
		});
		return;
	}
	if (!RmdEditorProvider.postToActive({ type: 'insertText', text })) {
		vscode.window.showInformationMessage('เปิดไฟล์ .r.md ก่อนใส่วันเวลา');
	}
}

// korn.openNote: find and open any .r.md in the workspace
async function openNote() {
	const files = await vscode.workspace.findFiles('**/*.r.md', '**/node_modules/**');
	if (files.length === 0) {
		vscode.window.showInformationMessage('ยังไม่มีไฟล์ .r.md ใน workspace');
		return;
	}
	const items = files
		.map((uri) => {
			const relative = vscode.workspace.asRelativePath(uri);
			const folder = path.posix.dirname(relative);
			return { label: path.posix.basename(relative), description: folder === '.' ? '' : folder, uri };
		})
		.sort((a, b) => (a.description + a.label).localeCompare(b.description + b.label));
	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Open a note', matchOnDescription: true });
	if (picked) {
		await vscode.commands.executeCommand('vscode.open', picked.uri);
	}
}

export function registerShortcutCommands(): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('korn.showMode', showMode),
		vscode.commands.registerCommand('korn.insertDateTime', insertDateTime),
		vscode.commands.registerCommand('korn.openNote', openNote),
	];
}
