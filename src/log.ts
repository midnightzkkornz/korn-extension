import * as vscode from 'vscode';

// Output → "Korn": what auto-sync did and why it skipped something
let channel: vscode.OutputChannel | undefined;

export function log(message: string) {
	channel ??= vscode.window.createOutputChannel('Korn');
	channel.appendLine(`[${new Date().toLocaleTimeString('en-GB')}] ${message}`);
}

export function showLog() {
	channel ??= vscode.window.createOutputChannel('Korn');
	channel.show(true);
}
