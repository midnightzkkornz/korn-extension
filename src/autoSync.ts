import * as vscode from 'vscode';
import type { ConflictStore } from './conflicts';
import { listRmdFiles } from './fileStatus';
import { getMergeState } from './gitSync';

const SAVE_DELAY_MS = 2000; // wait for a burst of saves to settle

export interface AutoSyncSettings {
	onSave: boolean;
	intervalMinutes: number;
}

export function readSettings(): AutoSyncSettings {
	const config = vscode.workspace.getConfiguration('korn.autoSync');
	return {
		onSave: config.get<boolean>('onSave', false),
		intervalMinutes: Math.max(0, config.get<number>('intervalMinutes', 0)),
	};
}

export function describeSettings(settings: AutoSyncSettings): string {
	const parts = [
		settings.onSave ? 'on save' : '',
		settings.intervalMinutes ? `ทุก ${settings.intervalMinutes} นาที` : '',
	].filter(Boolean);
	return parts.length ? `Auto-sync: ${parts.join(' · ')}` : 'Auto-sync: ปิด';
}

/**
 * Syncs .r.md files in the background (Settings → Korn):
 * - korn.autoSync.onSave: a few seconds after a file is saved
 * - korn.autoSync.intervalMinutes: every N minutes, every file with unsynced changes
 * Quiet: no popups on success; files with a conflict are skipped until it's handled.
 */
export class AutoSync implements vscode.Disposable {
	private settings = readSettings();
	private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private interval: ReturnType<typeof setInterval> | undefined;
	private lastError = ''; // warn once per distinct error, not every round
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly conflicts: ConflictStore,
		private readonly syncQuiet: (uri: vscode.Uri) => Promise<unknown>,
		private readonly onChange: () => void
	) {
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => this.onSaved(doc.uri)),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('korn.autoSync')) {
					this.settings = readSettings();
					this.restartInterval();
					this.onChange();
				}
			})
		);
		this.restartInterval();
	}

	get currentSettings(): AutoSyncSettings {
		return this.settings;
	}

	private onSaved(uri: vscode.Uri) {
		// A save done by Sync itself happens while the file is busy: skip it (no loop)
		if (!this.settings.onSave || !uri.path.endsWith('.r.md') || this.conflicts.isBusy(uri)) {
			return;
		}
		const key = uri.toString();
		clearTimeout(this.saveTimers.get(key));
		this.saveTimers.set(
			key,
			setTimeout(() => {
				this.saveTimers.delete(key);
				this.syncIfClean(uri);
			}, SAVE_DELAY_MS)
		);
	}

	private restartInterval() {
		clearInterval(this.interval);
		this.interval = undefined;
		if (this.settings.intervalMinutes > 0) {
			this.interval = setInterval(() => this.syncChangedFiles(), this.settings.intervalMinutes * 60_000);
		}
	}

	private async syncChangedFiles() {
		const rows = await listRmdFiles(this.conflicts);
		for (const row of rows) {
			if (row.state === 'dirty' || row.state === 'ahead') {
				await this.syncIfClean(vscode.Uri.parse(row.uri));
			}
		}
	}

	// Never touch a file that has a conflict or is being resolved
	private async syncIfClean(uri: vscode.Uri) {
		if (this.conflicts.has(uri) || this.conflicts.isBusy(uri) || (await getMergeState(uri)) !== 'none') {
			return;
		}
		try {
			await this.syncQuiet(uri);
			this.lastError = '';
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== this.lastError) {
				this.lastError = message;
				vscode.window.showWarningMessage(`Korn auto-sync: ${vscode.workspace.asRelativePath(uri)} ไม่สำเร็จ — ${message}`);
			}
		}
	}

	dispose() {
		clearInterval(this.interval);
		this.saveTimers.forEach((timer) => clearTimeout(timer));
		this.disposables.forEach((d) => d.dispose());
	}
}
