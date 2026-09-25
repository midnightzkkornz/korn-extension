import * as vscode from 'vscode';
import type { ConflictStore } from './conflicts';
import type { ConflictAction } from './gitSync';
import { getNonce, SYNC_ICON } from './util';

type PanelMessage = { type: 'sync' } | { type: 'resolve'; uri: string; action: ConflictAction };

// Side panel shown when clicking the Korn icon in the Activity Bar
export class SyncViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'korn.syncView';

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly conflicts: ConflictStore
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.getHtml();

		// The conflict box only shows up when a Sync hit a real conflict
		const postConflicts = () => webviewView.webview.postMessage({ type: 'conflicts', items: this.conflicts.list() });
		const sub = this.conflicts.onDidChange(postConflicts);
		webviewView.onDidDispose(() => sub.dispose());

		webviewView.webview.onDidReceiveMessage((message: PanelMessage | { type: 'ready' }) => {
			switch (message.type) {
				case 'ready':
					postConflicts();
					break;
				case 'sync':
					vscode.commands.executeCommand('korn.sync');
					break;
				case 'resolve':
					vscode.commands.executeCommand('korn.resolveConflict', message.uri, message.action);
					break;
			}
		});
	}

	private getHtml(): string {
		const nonce = getNonce();

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body {
			padding: 8px;
			color: var(--vscode-foreground);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		button {
			width: 100%;
			padding: 6px 10px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-family: inherit;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		#sync {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
		}
		#sync .icon {
			width: 16px;
			height: 16px;
			flex: none;
		}
		button.secondary {
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
		}
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.status {
			margin: 8px 0 16px;
			color: var(--vscode-descriptionForeground);
		}
		.conflict {
			margin-bottom: 12px;
			padding: 10px;
			border: 1px solid var(--vscode-editorWarning-foreground);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
		}
		.conflict h3 {
			margin: 0 0 4px;
			font-size: 1em;
			color: var(--vscode-editorWarning-foreground);
		}
		.conflict .file {
			font-family: var(--vscode-editor-font-family);
			word-break: break-all;
		}
		.conflict .hint {
			margin: 4px 0 10px;
			color: var(--vscode-descriptionForeground);
		}
		.conflict button { text-align: left; }
		.conflict button + button { margin-top: 6px; }
	</style>
</head>
<body>
	<button id="sync">${SYNC_ICON} Sync</button>
	<div class="status">Syncs the .r.md file that is open</div>

	<div id="conflicts"></div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const list = document.getElementById('conflicts');

		document.getElementById('sync').addEventListener('click', () => vscode.postMessage({ type: 'sync' }));

		const ACTIONS = [
			['keepMine', '1. Replace with my version', ''],
			['saveCopy', '2. Save my work as copy…', 'secondary'],
			['resolve', '3. Resolve in Korn', 'secondary'],
		];

		function render(items) {
			list.replaceChildren();
			for (const item of items) {
				const card = document.createElement('div');
				card.className = 'conflict';

				const title = document.createElement('h3');
				title.textContent = '⚠ Conflict';
				const file = document.createElement('div');
				file.className = 'file';
				file.textContent = item.name;
				const hint = document.createElement('div');
				hint.className = 'hint';
				hint.textContent = 'ไฟล์นี้ถูกแก้บน remote ด้วย เลือกวิธีจัดการ:';
				card.append(title, file, hint);

				for (const [action, label, cls] of ACTIONS) {
					const button = document.createElement('button');
					button.textContent = label;
					button.className = cls;
					button.addEventListener('click', () => vscode.postMessage({ type: 'resolve', uri: item.uri, action }));
					card.append(button);
				}
				list.append(card);
			}
		}

		window.addEventListener('message', (event) => {
			if (event.data.type === 'conflicts') {
				render(event.data.items);
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
