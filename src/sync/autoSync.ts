import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConflictStore } from '../state/conflicts';
import { listRmdFiles } from './fileStatus';
import { fetchRepo, getBranchInfo, getMergeState, pullRepo } from '../git/sync';
import { log } from '../shared/log';
import { decidePull } from './pullPolicy';

const SAVE_DELAY_MS = 2000; // wait for a burst of saves to settle
const RETRY_BUSY_MS = 5000; // a pull skipped because another sync was running is retried this soon

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
 * - korn.autoSync.intervalMinutes: every N minutes, send our changes and get what others pushed
 * Quiet: no popups on success; files with a conflict are skipped until it's handled.
 * Every decision is written to Output → "Korn".
 */
export class AutoSync implements vscode.Disposable {
	private settings = readSettings();
	private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private interval: ReturnType<typeof setInterval> | undefined;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private running = false; // one round at a time (a slow fetch must not stack rounds)
	private lastRemoteCheck = 0;
	private lastError = ''; // popup once per distinct error, not every round
	private readonly reloading = new Set<string>(); // saves we trigger ourselves after a pull
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly conflicts: ConflictStore,
		private readonly syncQuiet: (uri: vscode.Uri) => Promise<unknown>,
		private readonly onChange: () => void,
		private readonly onConflict: (uri: vscode.Uri) => void
	) {
		this.disposables.push(
			vscode.workspace.onDidSaveTextDocument((doc) => this.onSaved(doc.uri)),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('korn.autoSync')) {
					this.settings = readSettings();
					log(`settings: ${describeSettings(this.settings)}`);
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

	private get enabled(): boolean {
		return this.settings.onSave || this.settings.intervalMinutes > 0;
	}

	/** "Auto-sync: on save · ทุก 1 นาที" for the side panel (round times are in the log) */
	statusText(): string {
		return describeSettings(this.settings);
	}

	private onSaved(uri: vscode.Uri) {
		const key = uri.toString();
		if (this.reloading.delete(key)) {
			return; // our own save that reloads a pulled file, nothing to sync
		}
		// A save done by Sync itself happens while the file is busy: skip it (no loop)
		if (!this.settings.onSave || !uri.path.endsWith('.r.md') || this.conflicts.isBusy(uri)) {
			return;
		}
		clearTimeout(this.saveTimers.get(key));
		this.saveTimers.set(
			key,
			setTimeout(() => {
				this.saveTimers.delete(key);
				log(`on save: ${vscode.workspace.asRelativePath(uri)}`);
				this.syncIfClean(uri);
			}, SAVE_DELAY_MS)
		);
	}

	private restartInterval() {
		clearInterval(this.interval);
		this.interval = undefined;
		if (this.settings.intervalMinutes > 0) {
			this.interval = setInterval(() => this.round('interval'), this.settings.intervalMinutes * 60_000);
		}
	}

	/**
	 * Fetch every repo so the side panel can show "มีเวอร์ชันใหม่บน remote", and when auto-sync
	 * is on, get it right away instead of waiting for the next round.
	 * Called when VS Code gets focus or the panel opens; at most once a minute.
	 */
	async checkRemote() {
		if (Date.now() - this.lastRemoteCheck < 60_000) {
			return;
		}
		this.lastRemoteCheck = Date.now();
		if (this.enabled) {
			await this.round('focus');
		} else {
			await this.fetchAll();
			this.onChange();
		}
	}

	// One round: fetch, send our changes, get what others pushed
	private async round(trigger: string) {
		if (this.running) {
			log(`${trigger}: skipped, previous round still running`);
			return;
		}
		this.running = true;
		try {
			const roots = await this.fetchAll();
			const rows = await listRmdFiles(this.conflicts);
			for (const row of rows) {
				if (row.state === 'dirty' || row.state === 'ahead') {
					await this.syncIfClean(vscode.Uri.parse(row.uri));
				}
			}
			await this.pullAll(roots);
		} catch (error) {
			log(`${trigger}: failed — ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.running = false;
			this.onChange();
		}
	}

	private async fetchAll(): Promise<string[]> {
		const rows = await listRmdFiles(this.conflicts);
		const roots = [...new Set(rows.map((r) => r.root).filter((r): r is string => !!r))];
		const fetched = await Promise.all(roots.map((root) => fetchRepo(root)));
		const after = await listRmdFiles(this.conflicts);
		roots.forEach((root, i) => {
			const incoming = after.filter((r) => r.root === root && r.incoming).length;
			log(`fetch ${path.basename(root)}: ${fetched[i] ? `${incoming} file(s) with a newer version` : 'skipped (no upstream or offline)'}`);
		});
		return roots;
	}

	// Pull each repo when it's safe (see decidePull); log why when it isn't
	private async pullAll(roots: string[]) {
		const rows = await listRmdFiles(this.conflicts);
		let pulledFiles = 0;
		for (const root of roots) {
			const repo = path.basename(root);
			const repoRows = rows.filter((r) => r.root === root);
			const decision = decidePull(repoRows);
			if (!decision.pull) {
				if (decision.reason !== 'nothing new') {
					log(`pull ${repo}: waiting — ${decision.reason} (${decision.file})`);
				}
				if (decision.reason === 'busy') {
					this.retrySoon();
				}
				continue;
			}
			const incoming = repoRows.filter((r) => r.incoming);
			try {
				const result = await pullRepo(root);
				if (result.pulled) {
					pulledFiles += incoming.length;
					log(`pull ${repo}: got ${incoming.map((r) => r.name).join(', ')}`);
					await this.reloadOpenFiles(incoming.map((r) => vscode.Uri.parse(r.uri)));
				} else if (result.conflictFile) {
					const uri = vscode.Uri.file(path.join(root, result.conflictFile));
					log(`pull ${repo}: conflict in ${result.conflictFile}`);
					this.conflicts.add(uri);
					this.onConflict(uri);
				} else if (result.busy) {
					log(`pull ${repo}: skipped — ${result.busy} is syncing this repo`);
				} else if (result.skipped) {
					log(`pull ${repo}: waiting — ${result.skipped} has changes not synced yet (its Sync will merge)`);
				}
				this.lastError = '';
			} catch (error) {
				this.warnOnce(root, error);
			}
		}
		if (pulledFiles > 0) {
			vscode.window.setStatusBarMessage(`$(cloud-download) Korn: ดึงของใหม่ ${pulledFiles} ไฟล์`, 4000);
		}
	}

	private retrySoon() {
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => this.round('retry'), RETRY_BUSY_MS);
	}

	/**
	 * VS Code normally reloads an open file when git changes it on disk. If an open file still
	 * shows the old text (and has no unsaved edits), load the new text so no Cmd+R is needed.
	 */
	private async reloadOpenFiles(uris: vscode.Uri[]) {
		for (const uri of uris) {
			const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
			if (!doc || doc.isDirty) {
				continue;
			}
			let onDisk: string;
			try {
				onDisk = readFileSync(uri.fsPath, 'utf8');
			} catch {
				continue;
			}
			if (doc.getText() === onDisk) {
				continue;
			}
			log(`reload ${vscode.workspace.asRelativePath(uri)}: editor showed the old version`);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), onDisk);
			await vscode.workspace.applyEdit(edit);
			this.reloading.add(uri.toString());
			await doc.save(); // same text as on disk: clears the "unsaved" dot
		}
	}

	private warnOnce(target: string, error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		log(`error ${vscode.workspace.asRelativePath(target)}: ${message}`);
		if (message !== this.lastError) {
			this.lastError = message;
			vscode.window.showWarningMessage(`Korn auto-sync: ${vscode.workspace.asRelativePath(target)} ไม่สำเร็จ — ${message}`);
		}
	}

	// Never touch a file that has a conflict or is being resolved
	private async syncIfClean(uri: vscode.Uri) {
		const name = vscode.workspace.asRelativePath(uri);
		if (this.conflicts.has(uri) || this.conflicts.isBusy(uri)) {
			log(`sync ${name}: skipped (conflict or already syncing)`);
			return;
		}
		if ((await getMergeState(uri)) !== 'none') {
			log(`sync ${name}: skipped (merge in progress)`);
			return;
		}
		if ((await getBranchInfo(uri))?.detached) {
			log(`sync ${name}: skipped (detached HEAD — checkout a branch)`);
			return;
		}
		try {
			await this.syncQuiet(uri);
			log(`sync ${name}: done`);
			this.lastError = '';
		} catch (error) {
			this.warnOnce(uri.fsPath, error);
		}
	}

	dispose() {
		clearInterval(this.interval);
		clearTimeout(this.retryTimer);
		this.saveTimers.forEach((timer) => clearTimeout(timer));
		this.disposables.forEach((d) => d.dispose());
	}
}
