import * as vscode from 'vscode';
import type { ConflictStore } from './conflicts';
import { listRmdFiles } from './fileStatus';
import type { ConflictAction } from './gitSync';
import { showLog } from './log';
import { getNonce, SYNC_ICON } from './util';

type PanelMessage =
	| { type: 'ready' }
	| { type: 'syncAll' }
	| { type: 'syncFile'; uri: string }
	| { type: 'open'; uri: string }
	| { type: 'openSettings' }
	| { type: 'showLog' }
	| { type: 'resolve'; uri: string; action: ConflictAction };

const REFRESH_DELAY_MS = 500;

// Side panel shown when clicking the Korn icon in the Activity Bar:
// conflict cards, then every .r.md file with its sync state
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

	private async postFiles() {
		if (!this.view) {
			return;
		}
		const files = await listRmdFiles(this.conflicts);
		this.view.webview.postMessage({ type: 'files', files, autoSync: this.autoSyncText() });
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.getHtml();

		// The conflict box only shows up when a Sync hit a real conflict
		const postConflicts = () => webviewView.webview.postMessage({ type: 'conflicts', items: this.conflicts.list() });
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

		webviewView.webview.onDidReceiveMessage((message: PanelMessage) => {
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
		button:disabled { opacity: 0.5; cursor: default; }
		.icon { width: 16px; height: 16px; flex: none; }
		#syncAll {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 6px;
		}
		button.secondary {
			color: var(--vscode-button-secondaryForeground);
			background: var(--vscode-button-secondaryBackground);
		}
		button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
		.auto-line {
			display: flex;
			flex-wrap: wrap;
			justify-content: space-between;
			gap: 2px 10px;
			margin: 6px 0 14px;
		}
		.auto {
			display: block;
			margin: 0;
			padding: 0;
			width: auto;
			text-align: left;
			color: var(--vscode-textLink-foreground);
			background: none;
		}
		.auto:hover { background: none; text-decoration: underline; }

		/* Conflict cards */
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

		/* File list */
		.section {
			margin: 4px 0 4px;
			font-size: 0.85em;
			font-weight: 600;
			letter-spacing: 0.04em;
			color: var(--vscode-descriptionForeground);
		}
		.files { list-style: none; margin: 0; padding: 0; }
		.row {
			display: grid;
			grid-template-columns: 1fr auto;
			align-items: center;
			gap: 0 6px;
			padding: 3px 4px;
			border-radius: 3px;
		}
		.row:hover { background: var(--vscode-list-hoverBackground); }
		.row .name {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			cursor: pointer;
		}
		.row .name:hover { text-decoration: underline; }
		.row .state {
			grid-column: 1;
			display: flex;
			align-items: center;
			gap: 5px;
			font-size: 0.9em;
			color: var(--vscode-descriptionForeground);
			font-variant-numeric: tabular-nums;
		}
		.row .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
		.row .sync {
			grid-column: 2;
			grid-row: 1 / span 2;
			display: grid;
			place-items: center;
			width: 26px;
			height: 26px;
			padding: 0;
			color: var(--vscode-foreground);
			background: transparent;
		}
		.row .sync:hover { background: var(--vscode-toolbar-hoverBackground); }
		/* s- prefix so these never pick up the .conflict card styles */
		.dot.s-conflict { background: var(--vscode-charts-orange); }
		.dot.s-dirty { background: var(--vscode-charts-yellow); }
		.dot.s-ahead { background: var(--vscode-charts-blue); }
		.dot.s-blocked { background: transparent; box-shadow: inset 0 0 0 2px var(--vscode-charts-blue); }
		.dot.s-incoming { background: var(--vscode-charts-purple); }
		.incoming-note { color: var(--vscode-charts-purple); }
		.dot.s-synced { background: var(--vscode-charts-green); }
		.dot.s-never, .dot.s-nogit { background: var(--vscode-disabledForeground, #888); }
		.empty { color: var(--vscode-descriptionForeground); }
	</style>
</head>
<body>
	<button id="syncAll" disabled>${SYNC_ICON}<span id="syncAllLabel">Sync all</span></button>
	<div class="auto-line">
		<button id="auto" class="auto" title="เปิด Settings ของ auto-sync">Auto-sync: …</button>
		<button id="showLog" class="auto" title="Output → Korn: สิ่งที่ auto-sync ทำ และเหตุผลที่ข้าม">log</button>
	</div>

	<div id="conflicts"></div>

	<div class="section">FILES</div>
	<ul class="files" id="files"><li class="empty">กำลังโหลด…</li></ul>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const conflictList = document.getElementById('conflicts');
		const fileList = document.getElementById('files');
		const syncAll = document.getElementById('syncAll');
		const syncAllLabel = document.getElementById('syncAllLabel');
		const auto = document.getElementById('auto');
		const SYNC_ICON = ${JSON.stringify(SYNC_ICON)};

		syncAll.addEventListener('click', () => vscode.postMessage({ type: 'syncAll' }));
		auto.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
		document.getElementById('showLog').addEventListener('click', () => vscode.postMessage({ type: 'showLog' }));

		const ACTIONS = [
			['keepMine', '1. Replace with my version', ''],
			['saveCopy', '2. Save my work as copy…', 'secondary'],
			['resolve', '3. Resolve in Korn', 'secondary'],
		];
		// While "Resolve in Korn" is in progress: continue it, switch to 1/2, or cancel
		const RESOLVING_ACTIONS = [
			['resolve', '3. Continue in Resolve', ''],
			['keepMine', '1. Replace with my version', 'secondary'],
			['saveCopy', '2. Save my work as copy…', 'secondary'],
			['cancel', 'Cancel resolve — เลือกวิธีอื่น', 'secondary'],
		];

		function renderConflicts(items) {
			conflictList.replaceChildren();
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
				hint.textContent = item.busy
					? 'กำลังจัดการ…'
					: item.resolving
						? 'กำลังแก้ในแท็บ ⚠ Resolve'
						: 'ไฟล์นี้ถูกแก้บน remote ด้วย เลือกวิธีจัดการ:';
				card.append(title, file, hint);

				for (const [action, label, cls] of item.resolving ? RESOLVING_ACTIONS : ACTIONS) {
					const button = document.createElement('button');
					button.textContent = label;
					button.className = cls;
					button.disabled = item.busy; // one action at a time per file
					button.addEventListener('click', () => vscode.postMessage({ type: 'resolve', uri: item.uri, action }));
					card.append(button);
				}
				conflictList.append(card);
			}
		}

		function formatTime(iso) {
			const d = new Date(iso);
			const pad = (n) => String(n).padStart(2, '0');
			return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
		}

		function stateLabel(file) {
			if (file.busy) return 'Syncing…';
			switch (file.state) {
				case 'conflict': return 'conflict';
				case 'dirty': return 'แก้แล้ว ยังไม่ sync';
				case 'ahead': return 'commit แล้ว รอ push';
				case 'blocked': return 'รอ push — ติด conflict ของ ' + file.blockedBy;
				case 'incoming': return file.unsaved ? 'มีของใหม่ — เซฟแล้วจะรวมให้' : 'มีเวอร์ชันใหม่บน remote';
				case 'synced': return file.lastSync ? formatTime(file.lastSync) : 'sync แล้ว';
				case 'nogit': return 'ไม่ได้อยู่ใน git repo';
				default: return 'ยังไม่เคย sync';
			}
		}

		function renderFiles(files) {
			fileList.replaceChildren();
			if (files.length === 0) {
				const empty = document.createElement('li');
				empty.className = 'empty';
				empty.textContent = 'ยังไม่มีไฟล์ .r.md — กดปุ่ม 📄 ด้านบนเพื่อสร้าง';
				fileList.append(empty);
			}
			for (const file of files) {
				const row = document.createElement('li');
				row.className = 'row';

				const name = document.createElement('span');
				name.className = 'name';
				name.textContent = file.name;
				name.title = 'เปิด ' + file.name;
				name.addEventListener('click', () => vscode.postMessage({ type: 'open', uri: file.uri }));

				const sync = document.createElement('button');
				sync.className = 'sync';
				sync.title =
					file.state === 'blocked'
						? 'จะ push ให้เองหลังแก้ conflict ของ ' + file.blockedBy
						: file.state === 'incoming'
							? 'ดึงเวอร์ชันใหม่มาจาก remote'
							: file.state === 'ahead'
								? 'กดเพื่อ push อีกครั้ง'
								: 'Sync ' + file.name;
				sync.innerHTML = SYNC_ICON; // static icon markup
				// blocked: pushing can't work until the conflict is handled
				sync.disabled = file.busy || file.state === 'nogit' || file.state === 'blocked';
				sync.addEventListener('click', () => vscode.postMessage({ type: 'syncFile', uri: file.uri }));

				const state = document.createElement('span');
				state.className = 'state';
				state.title = sync.title;
				const dot = document.createElement('span');
				dot.className = 'dot s-' + file.state;
				state.append(dot, document.createTextNode(stateLabel(file)));
				// our own changes and a newer remote version at the same time: say both
				if (file.incoming && file.state !== 'incoming' && file.state !== 'conflict' && !file.busy) {
					const note = document.createElement('span');
					note.className = 'incoming-note';
					note.textContent = '· มีของใหม่บน remote';
					state.append(note);
				}

				row.append(name, sync, state);
				fileList.append(row);
			}

			const pending = files.filter(
				(f) => (f.state === 'dirty' || f.state === 'ahead' || f.state === 'incoming') && !f.busy
			).length;
			syncAllLabel.textContent = pending ? 'Sync all (' + pending + ')' : 'Sync all';
			syncAll.disabled = pending === 0;
			syncAll.title = pending ? 'ส่งของเราและดึงของใหม่จาก remote ทั้งหมด' : 'ทุกไฟล์ sync แล้ว';
		}

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'conflicts') {
				renderConflicts(message.items);
			} else if (message.type === 'files') {
				renderFiles(message.files);
				auto.textContent = message.autoSync;
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}
