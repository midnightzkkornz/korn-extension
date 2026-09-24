import * as vscode from 'vscode';
import { getNonce } from './util';

type EditorMessage = { type: 'ready' | 'sync' | 'edit' };

// PDF-style viewer for *.r.md: custom toolbar on top + markdown rendered by VS Code's own engine
export class RmdEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'korn.rmdEditor';

	async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const docFolder = vscode.Uri.joinPath(document.uri, '..');
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [docFolder, ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? [])],
		};
		panel.webview.html = this.getHtml(panel.webview, document);

		const update = async () => {
			panel.webview.postMessage({ type: 'render', html: await renderMarkdown(document.getText()) });
		};

		// Re-render when the file is edited in the text editor (Edit button)
		const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() === document.uri.toString()) {
				update();
			}
		});
		panel.onDidDispose(() => changeSub.dispose());

		panel.webview.onDidReceiveMessage((message: EditorMessage) => {
			switch (message.type) {
				case 'ready':
					update();
					break;
				case 'sync':
					vscode.commands.executeCommand('korn.sync', document.uri);
					break;
				case 'edit':
					vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
					break;
			}
		});
	}

	private getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
		const nonce = getNonce();
		const fileName = escapeHtml(vscode.workspace.asRelativePath(document.uri));

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body {
			margin: 0;
			padding: 0;
			color: var(--vscode-editor-foreground);
			background: var(--vscode-editor-background);
			font-family: var(--vscode-markdown-font-family, var(--vscode-font-family));
			font-size: 14px;
			line-height: 1.6;
		}

		/* Toolbar */
		.toolbar {
			position: sticky;
			top: 0;
			z-index: 1;
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 6px 16px;
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			background: var(--vscode-editorWidget-background);
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.toolbar .file { font-weight: 600; }
		.toolbar .status {
			display: flex;
			align-items: center;
			gap: 6px;
			color: var(--vscode-descriptionForeground);
		}
		.toolbar .dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: var(--vscode-charts-yellow);
		}
		.toolbar .spacer { flex: 1; }
		.toolbar button {
			padding: 4px 12px;
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-family: inherit;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}
		.toolbar button:hover { background: var(--vscode-button-hoverBackground); }
		.toolbar button.secondary {
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
		}
		.toolbar button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

		/* Rendered markdown (close to VS Code's markdown preview) */
		main {
			max-width: 880px;
			margin: 0 auto;
			padding: 16px 26px 48px;
		}
		h1, h2 {
			padding-bottom: 0.3em;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.6em; }
		a { color: var(--vscode-textLink-foreground); }
		a:hover { color: var(--vscode-textLink-activeForeground); }
		code {
			font-family: var(--vscode-editor-font-family);
			font-size: 0.9em;
			padding: 0.1em 0.3em;
			border-radius: 3px;
			background: var(--vscode-textCodeBlock-background);
		}
		pre {
			padding: 12px 16px;
			overflow-x: auto;
			border-radius: 4px;
			background: var(--vscode-textCodeBlock-background);
		}
		pre code { padding: 0; background: none; }
		blockquote {
			margin: 0 0 1em;
			padding: 0 16px;
			border-left: 4px solid var(--vscode-textBlockQuote-border);
			background: var(--vscode-textBlockQuote-background);
		}
		table { border-collapse: collapse; margin-bottom: 1em; }
		th, td { padding: 6px 12px; border: 1px solid var(--vscode-panel-border); }
		hr { border: none; border-top: 1px solid var(--vscode-panel-border); }
		img { max-width: 100%; }
	</style>
</head>
<body>
	<div class="toolbar">
		<span class="file">${fileName}</span>
		<span class="status"><span class="dot"></span>Last sync: never</span>
		<span class="spacer"></span>
		<button id="edit" class="secondary">✎ Edit</button>
		<button id="sync">⟳ Sync</button>
	</div>
	<main id="content"></main>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const content = document.getElementById('content');

		for (const id of ['edit', 'sync']) {
			document.getElementById(id).addEventListener('click', () => vscode.postMessage({ type: id }));
		}

		window.addEventListener('message', (event) => {
			if (event.data.type === 'render') {
				content.innerHTML = event.data.html;
			}
		});

		vscode.postMessage({ type: 'ready' });
	</script>
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
