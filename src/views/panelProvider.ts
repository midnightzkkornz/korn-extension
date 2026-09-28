import * as vscode from 'vscode';
import type { ConflictStore } from '../state/conflicts';
import { listRmdFiles } from '../sync/fileStatus';
import { showLog } from '../shared/log';
import type { HostToPanel, PanelToHost } from '../shared/protocol';
import { getNonce } from '../shared/util';

const REFRESH_DELAY_MS = 500;

// Side panel shown when clicking the Korn icon in the Activity Bar:
// conflict cards, then every .r.md file with its sync state.
// The UI is the Preact app in webview/panel; this class feeds it data and runs what it asks for.
export class SyncViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'korn.syncView';

	private view: vscode.WebviewView | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	/** Called when the panel opens or becomes visible (used to check the remote for updates) */
	onShow: () => void = () => {};

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly conflicts: ConflictStore,
		private readonly autoSyncText: () => string
	) {}

	/** Re-read the file list (debounced); called on save, sync, file create/delete, window focus… */
	refresh() {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => this.postFiles(), REFRESH_DELAY_MS);
	}

	private post(message: HostToPanel) {
		this.view?.webview.postMessage(message);
	}

	private async postFiles() {
		if (!this.view) {
			return;
		}
		const files = await listRmdFiles(this.conflicts);
		this.post({ type: 'files', files, autoSync: this.autoSyncText() });
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out')],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		// The conflict box only shows up when a Sync hit a real conflict
		const postConflicts = () => this.post({ type: 'conflicts', items: this.conflicts.list() });
		const sub = this.conflicts.onDidChange(() => {
			postConflicts();
			this.refresh(); // busy / conflict state shows in the file list too
		});
		const visibleSub = webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.refresh();
				this.onShow();
			}
		});
		webviewView.onDidDispose(() => {
			sub.dispose();
			visibleSub.dispose();
			this.view = undefined;
		});

		webviewView.webview.onDidReceiveMessage((message: PanelToHost) => {
			switch (message.type) {
				case 'ready':
					postConflicts();
					this.postFiles();
					this.onShow();
					break;
				case 'syncAll':
					vscode.commands.executeCommand('korn.syncAll');
					break;
				case 'syncFile':
					vscode.commands.executeCommand('korn.sync', vscode.Uri.parse(message.uri));
					break;
				case 'open':
					vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(message.uri));
					break;
				case 'showLog':
					showLog();
					break;
				case 'openSettings':
					vscode.commands.executeCommand('workbench.action.openSettings', 'korn.autoSync');
					break;
				case 'resolve':
					vscode.commands.executeCommand('korn.resolveConflict', message.uri, message.action);
					break;
			}
		});
	}

	// Just a shell: the UI is bundled from webview/panel to out/panel.js + out/panel.css
	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'out', file));

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${asset('panel.css')}">
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
	}
}
