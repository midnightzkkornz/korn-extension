import * as vscode from 'vscode';
import type { ConflictStore } from './conflicts';
import { getLastSyncTime, getMergeState, SyncOutcome } from './gitSync';
import { getNonce, SYNC_ICON } from './util';

// Messages from the webview (see webview/main.ts)
type EditorMessage = { type: 'ready' } | { type: 'sync' } | { type: 'edit'; text: string; seq: number };

// Korn editor for *.r.md: one tab with an always-visible toolbar and 4 modes
// (Korn / Text / Preview / Editor). The UI lives in webview/ and is bundled into out/webview.js.
export class RmdEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'korn.rmdEditor';

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly conflicts: ConflictStore
	) {}

	async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const docFolder = vscode.Uri.joinPath(document.uri, '..');
		const markdownMedia = markdownMediaUri();
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'out'),
				...(markdownMedia ? [markdownMedia] : []),
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

		// Toolbar status: conflict (from the side panel's list) or the last sync time from git
		const postSyncState = async () => {
			// Read from git first, so it's still right after a reload
			const merge = await getMergeState(document.uri);
			if (merge === 'unresolved') {
				panel.webview.postMessage({ type: 'syncState', state: 'conflict' });
				return;
			}
			if (merge === 'resolved') {
				panel.webview.postMessage({ type: 'syncState', state: 'merging' });
				return;
			}
			if (this.conflicts.has(document.uri)) {
				panel.webview.postMessage({ type: 'syncState', state: 'conflict' });
				return;
			}
			const time = await getLastSyncTime(document.uri);
			panel.webview.postMessage(
				time ? { type: 'syncState', state: 'done', time: time.toISOString() } : { type: 'syncState', state: 'idle' }
			);
		};
		const conflictSub = this.conflicts.onDidChange(postSyncState);
		const saveSub = vscode.workspace.onDidSaveTextDocument((d) => {
			if (d.uri.toString() === document.uri.toString()) {
				postSyncState();
			}
		});

		const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
				sendUpdate('update');
			}
		});
		panel.onDidDispose(() => {
			clearTimeout(renderTimer);
			changeSub.dispose();
			conflictSub.dispose();
			saveSub.dispose();
		});

		panel.webview.onDidReceiveMessage(async (message: EditorMessage) => {
			switch (message.type) {
				case 'ready':
					ackSeq = 0; // webview (re)loaded, its edit counter starts over
					sendUpdate('init');
					postSyncState();
					break;
				case 'edit':
					applyWebviewEdit(message.text, message.seq);
					break;
				case 'sync': {
					panel.webview.postMessage({ type: 'syncState', state: 'syncing' });
					await editQueue; // make sure everything typed so far is in the document
					try {
						const result = await vscode.commands.executeCommand<SyncOutcome | undefined>('korn.sync', document.uri);
						if (result?.kind === 'synced') {
							const time = (await getLastSyncTime(document.uri)) ?? result.time;
							panel.webview.postMessage({ type: 'syncState', state: 'done', time: time.toISOString() });
						} else {
							postSyncState();
						}
					} catch {
						panel.webview.postMessage({ type: 'syncState', state: 'error' });
					}
					break;
				}
			}
		});
	}

	private getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
		const nonce = getNonce();
		const fileName = escapeHtml(vscode.workspace.asRelativePath(document.uri));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'webview.css'));
		// Same stylesheets as VS Code's own Markdown Preview, so rendered markdown looks identical
		const media = markdownMediaUri();
		const markdownStyles = media
			? ['markdown.css', 'highlight.css']
					.map((file) => `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, file))}">`)
					.join('\n\t')
			: '';

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${markdownStyles}
	<link rel="stylesheet" href="${styleUri}">
</head>
<body data-mode="view">
	<div class="toolbar">
		<div class="nav">
			<button data-mode="view" title="Rendered view (read-only)">View</button>
			<button data-mode="text" title="Edit markdown source">Text</button>
			<button data-mode="preview" title="Source + live preview">Preview</button>
			<button data-mode="editor" title="WYSIWYG editor">Editor</button>
		</div>
		<span class="file">${fileName}</span>
		<span class="status" id="status"><span class="dot"></span><span id="status-text">Last sync: never</span></span>
		<span class="spacer"></span>
		<button id="sync">
			${SYNC_ICON}
			Sync
		</button>
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

// media/ folder of VS Code's built-in markdown extension (markdown.css, highlight.css)
function markdownMediaUri(): vscode.Uri | undefined {
	const ext = vscode.extensions.getExtension('vscode.markdown-language-features');
	return ext ? vscode.Uri.joinPath(ext.extensionUri, 'media') : undefined;
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
