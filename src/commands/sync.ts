import * as vscode from 'vscode';
import { ctx } from '../context';
import { SyncOutcome, syncFile } from '../git/sync';
import { showBusy, showGitError } from '../shared/ui';
import { listRmdFiles } from '../sync/fileStatus';
import { offerBackgroundSync } from './background';
import { askConflictAction, notifyConflict } from './conflict';
import { activeUri } from './editors';

/**
 * Sync one file. Used by the Sync buttons (quiet = false) and by auto-sync / Sync all (quiet = true):
 * quiet = no popups on success, and a conflict gives one notification instead of opening the choices.
 */
export async function syncOne(target: vscode.Uri, { quiet = false } = {}): Promise<SyncOutcome | undefined> {
	const { conflicts, panel } = ctx;
	const name = vscode.workspace.asRelativePath(target);
	try {
		const run = await conflicts.runExclusive(target, () =>
			quiet
				? syncFile(target)
				: vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sync ${name}…` }, () =>
						syncFile(target)
					)
		);
		if (!run) {
			if (!quiet) {
				showBusy(name);
			}
			return undefined;
		}
		const result = run.value;
		if (result.kind === 'conflict') {
			conflicts.add(target);
			if (quiet) {
				notifyConflict(target);
			} else {
				askConflictAction(target); // not awaited: the Sync button finishes with state "conflict"
			}
		} else if (result.kind === 'synced') {
			conflicts.remove(target);
			if (quiet) {
				vscode.window.setStatusBarMessage(`$(check) Korn: synced ${name}`, 3000);
			} else {
				vscode.window.showInformationMessage(
					result.committed ? `Synced: ${result.message}` : `ไม่มีการเปลี่ยนแปลงใน ${name} — push แล้ว`
				);
				offerBackgroundSync(ctx.state); // once ever: keep syncing after VS Code closes?
			}
		}
		return result;
	} catch (error) {
		if (!quiet) {
			showGitError(`Sync ${name} ไม่สำเร็จ`, error);
		}
		throw error;
	} finally {
		panel.refresh();
	}
}

async function syncAll() {
	// ours to send (dirty / ahead) and others' to get (incoming)
	const rows = (await listRmdFiles(ctx.conflicts)).filter(
		(row) => row.state === 'dirty' || row.state === 'ahead' || row.state === 'incoming'
	);
	if (rows.length === 0) {
		vscode.window.showInformationMessage('ทุกไฟล์ sync แล้ว');
		return;
	}
	let synced = 0;
	const failed: string[] = [];
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Sync all' }, async (progress) => {
		for (const [i, row] of rows.entries()) {
			progress.report({ message: `${row.name} (${i + 1}/${rows.length})`, increment: 100 / rows.length });
			try {
				const result = await syncOne(vscode.Uri.parse(row.uri), { quiet: true });
				if (result?.kind === 'synced') {
					synced++;
				}
			} catch (error) {
				failed.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});
	const summary = `Sync all: สำเร็จ ${synced}/${rows.length} ไฟล์`;
	if (failed.length) {
		vscode.window.showWarningMessage(`${summary} — ไม่สำเร็จ: ${failed.join(' · ')}`);
	} else {
		vscode.window.showInformationMessage(summary);
	}
}

export function registerSyncCommands(): vscode.Disposable[] {
	return [
		// Sync button (Korn toolbar, editor title bar, side panel): add + commit + push this file
		vscode.commands.registerCommand('korn.sync', async (uri?: vscode.Uri): Promise<SyncOutcome | undefined> => {
			const target = activeUri(uri);
			if (!target || !target.path.endsWith('.r.md')) {
				vscode.window.showWarningMessage('เปิดไฟล์ .r.md ก่อนกด Sync');
				return undefined;
			}
			return syncOne(target);
		}),

		// Sync every .r.md that has unsynced changes (side panel "Sync all")
		vscode.commands.registerCommand('korn.syncAll', () => syncAll()),
	];
}
