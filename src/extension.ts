import * as vscode from 'vscode';

// Called once when the extension is activated (first time the command runs)
export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('korn-extension.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from Korn Extension!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
