import * as vscode from 'vscode';
import { getNonce, SYNC_ICON } from './util';

type PanelMessage = { type: 'sync' | 'replace' | 'keep' };

// Side panel shown when clicking the Korn icon in the Activity Bar
export class SyncViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'korn.syncView';

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.getHtml();

		webviewView.webview.onDidReceiveMessage((message: PanelMessage) => {
			switch (message.type) {
				case 'sync':
					vscode.commands.executeCommand('korn.sync');
					break;
				case 'replace':
					vscode.window.showInformationMessage('Replace with version: ยังไม่ได้ทำ logic');
					break;
				case 'keep':
					vscode.window.showInformationMessage('Keep mine: ยังไม่ได้ทำ logic');
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
			padding: 10px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			background: var(--vscode-editorWidget-background);
		}
		.conflict h3 {
			margin: 0 0 4px;
			font-size: 1em;
			color: var(--vscode-editorWarning-foreground);
		}
		.conflict .file {
			margin-bottom: 10px;
			font-family: var(--vscode-editor-font-family);
			color: var(--vscode-descriptionForeground);
		}
		.conflict button + button { margin-top: 6px; }
	</style>
</head>
<body>
	<button id="sync">${SYNC_ICON} Sync</button>
	<div class="status">Last sync: never</div>

	<div class="conflict">
		<h3>⚠ Conflict?</h3>
		<div class="file">notes.r.md (ข้อมูลตัวอย่าง)</div>
		<button id="replace">1. Replace with version</button>
		<button id="keep" class="secondary">2. Keep mine</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		for (const id of ['sync', 'replace', 'keep']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}
	</script>
</body>
</html>`;
	}
}
