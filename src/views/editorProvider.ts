import * as vscode from 'vscode';
import type { ConflictStore } from '../state/conflicts';
import { getBranchInfo, getLastSyncTime, getMergeState, SyncOutcome } from '../git/sync';
import { getNonce, SYNC_ICON } from '../shared/util';

// Messages from the webview (see webview/main.ts)
type EditorMessage =
	| { type: 'ready' }
	| { type: 'sync' }
	| { type: 'edit'; text: string; seq: number }
	// Resolve mode (webview/resolve.ts)
	| { type: 'renderMany'; requestId: number; texts: string[] }
	| { type: 'finishResolve'; text: string }
	| { type: 'openTextEditor' }
	| { type: 'reopenConflict' }
	| { type: 'cancelResolve' };

// Korn editor for *.r.md: one tab with an always-visible toolbar and 4 modes
// (Korn / Text / Preview / Editor). The UI lives in webview/editor/ and is bundled into out/editor.js.
export class RmdEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'korn.rmdEditor';

	// The Korn tab that has focus, for keyboard shortcuts (korn.showMode, korn.insertDateTime)
	private static activePanel: vscode.WebviewPanel | undefined;

	/** Send a message to the focused Korn tab. Returns false when no Korn tab is active. */
	static postToActive(message: unknown): boolean {
		const panel = RmdEditorProvider.activePanel;
		if (!panel?.active) {
			return false;
		}
		panel.webview.postMessage(message);
		return true;
	}

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

		if (panel.active) {
			RmdEditorProvider.activePanel = panel;
		}
		const viewStateSub = panel.onDidChangeViewState(() => {
			if (panel.active) {
				RmdEditorProvider.activePanel = panel;
			}
		});

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
			// Sync button tooltip: which branch it syncs to
			const branch = await getBranchInfo(document.uri);
			const syncTarget = !branch
				? 'ไฟล์นี้ไม่ได้อยู่ใน git repo'
				: branch.detached
					? 'อยู่ใน detached HEAD — checkout branch ก่อนแล้วค่อย Sync'
					: branch.upstream
						? `Sync ไป ${branch.upstream}`
						: `Sync ไป origin/${branch.branch} (ครั้งแรกจะสร้าง branch นี้บน remote)`;
			panel.webview.postMessage({ type: 'syncTarget', title: syncTarget });

			// Read from git first, so it's still right after a reload
			const merge = await getMergeState(document.uri);
			if (merge === 'unresolved') {
				// "Resolve in Korn" chosen, markers still in the file
				panel.webview.postMessage({ type: 'syncState', state: 'resolving' });
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
			viewStateSub.dispose();
			if (RmdEditorProvider.activePanel === panel) {
				RmdEditorProvider.activePanel = undefined;
			}
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
				case 'sync':
					await runSync();
					break;
				case 'renderMany': {
					const htmls = await Promise.all(message.texts.map(renderMarkdown));
					panel.webview.postMessage({ type: 'renderedMany', requestId: message.requestId, texts: message.texts, htmls });
					break;
				}
				case 'finishResolve':
					// Write the resolved text, save, then Sync concludes the merge and pushes
					await editQueue;
					if (document.getText() !== message.text) {
						const edit = new vscode.WorkspaceEdit();
						edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), message.text);
						await vscode.workspace.applyEdit(edit);
					}
					await document.save();
					await runSync();
					break;
				case 'openTextEditor':
					vscode.commands.executeCommand('korn.openTextEditor', document.uri);
					break;
				case 'cancelResolve':
					vscode.commands.executeCommand('korn.resolveConflict', document.uri, 'cancel');
					break;
				case 'reopenConflict':
					vscode.commands.executeCommand('korn.showConflictChoices', document.uri);
					break;
			}
		});

		// Sync button and "Finish & Sync" in Resolve mode
		const runSync = async () => {
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
		};

	}

	private getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
		const nonce = getNonce();
		const fileName = escapeHtml(vscode.workspace.asRelativePath(document.uri));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'editor.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', 'editor.css'));
		// Same stylesheets as VS Code's own Markdown Preview, so rendered markdown looks identical
		const media = markdownMediaUri();
		const markdownStyles = media
			? ['markdown.css', 'highlight.css']
					.map((file) => `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, file))}">`)
					.join('\n\t')
			: '';
		// Relative paths in the markdown (![](img.png)) resolve against the file's folder.
		// The folder is in localResourceRoots; scripts/styles above use absolute URLs, so they're unaffected.
		const baseHref = `${webview.asWebviewUri(vscode.Uri.joinPath(document.uri, '..'))}/`;

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<base href="${escapeHtml(baseHref)}">
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
			<button data-mode="resolve" class="resolve-tab" title="Resolve merge conflicts" hidden>⚠ Resolve</button>
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
		<div id="resolve"></div>
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
