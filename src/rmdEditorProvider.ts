import * as vscode from 'vscode';
import { getNonce } from './util';

// Messages from the webview (see webview/main.ts)
type EditorMessage = { type: 'ready' } | { type: 'sync' } | { type: 'edit'; text: string; seq: number };

// Korn editor for *.r.md: one tab with an always-visible toolbar and 4 modes
// (Korn / Text / Preview / Editor). The UI lives in webview/ and is bundled into out/webview.js.
export class RmdEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'korn.rmdEditor';

	constructor(private readonly extensionUri: vscode.Uri) {}

	async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const docFolder = vscode.Uri.joinPath(document.uri, '..');
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'out'),
				docFolder,
				...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
			],
		};
		panel.webview.html = this.getHtml(panel.webview, document);

		// Edits from the webview are applied in order. `ackSeq` tells the webview which of its
		// edits are already in the document, so it never gets overwritten with older text mid-typing.
		let ackSeq = 0;
		let editQueue = Promise.resolve();

		const applyWebviewEdit = (text: string, seq: number) => {
			editQueue = editQueue.then(async () => {
				if (document.getText() !== text) {
					const edit = new vscode.WorkspaceEdit();
					edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
					await vscode.workspace.applyEdit(edit);
				}
				ackSeq = seq;
				sendUpdate('update');
			});
		};

		let renderTimer: ReturnType<typeof setTimeout> | undefined;
		const sendUpdate = (type: 'init' | 'update') => {
			clearTimeout(renderTimer);
			renderTimer = setTimeout(
				async () => {
					const text = document.getText();
					const html = await renderMarkdown(text);
					panel.webview.postMessage({ type, text, html, ackSeq });
				},
				type === 'init' ? 0 : 100
			);
		};

		const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
				sendUpdate('update');
			}
		});
		panel.onDidDispose(() => {
			clearTimeout(renderTimer);
			changeSub.dispose();
		});

		panel.webview.onDidReceiveMessage((message: EditorMessage) => {
			switch (message.type) {
				case 'ready':
					ackSeq = 0; // webview (re)loaded, its edit counter starts over
					sendUpdate('init');
					break;
				case 'edit':
					applyWebviewEdit(message.text, message.seq);
					break;
				case 'sync':
					vscode.commands.executeCommand('korn.sync', document.uri);
					break;
			}
		});
	}

	private getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
		const nonce = getNonce();
		const fileName = escapeHtml(vscode.workspace.asRelativePath(document.uri));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.css'));

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${styleUri}">
</head>
<body data-mode="korn">
	<div class="toolbar">
		<div class="nav">
			<button data-mode="korn" title="Rendered view">Korn</button>
			<button data-mode="text" title="Edit markdown source">Text</button>
			<button data-mode="preview" title="Source + live preview">Preview</button>
			<button data-mode="editor" title="WYSIWYG editor">Editor</button>
		</div>
		<span class="file">${fileName}</span>
		<span class="status"><span class="dot"></span>Last sync: never</span>
		<span class="spacer"></span>
		<button id="sync">⟳ Sync</button>
	</div>
	<div id="panes">
		<div id="text"></div>
		<div id="wysiwyg"></div>
		<main id="rendered"></main>
	</div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

async function renderMarkdown(text: string): Promise<string> {
	try {
		// Provided by VS Code's built-in markdown extension
		return await vscode.commands.executeCommand<string>('markdown.api.render', text);
	} catch {
		return `<pre>${escapeHtml(text)}</pre>`;
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
