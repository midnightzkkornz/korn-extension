import * as vscode from 'vscode';

// Small notifications used by several commands

export function showBusy(name: string) {
	vscode.window.showInformationMessage(`กำลังจัดการ ${name} อยู่ รอสักครู่`);
}

export function showGitError(title: string, error: unknown) {
	const detail = error instanceof Error ? error.message : String(error);
	vscode.window
		.showErrorMessage(`${title}: ${detail}`, 'Open Source Control')
		.then((choice) => choice && vscode.commands.executeCommand('workbench.view.scm'));
}
