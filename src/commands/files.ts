import * as vscode from 'vscode';

// korn.newFile: create "<name>.r.md" in the first workspace folder and open it
async function newFile() {
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
}

export function registerFileCommands(): vscode.Disposable[] {
	return [vscode.commands.registerCommand('korn.newFile', newFile)];
}
