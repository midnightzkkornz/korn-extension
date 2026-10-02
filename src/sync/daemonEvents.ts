import { unwatchFile, watchFile } from 'fs';
import * as vscode from 'vscode';
import {
	DaemonEvent,
	eventsFile,
	folderShowsRepo,
	HEARTBEAT_MS,
	lastEventId,
	readEvents,
	removeHeartbeat,
	writeHeartbeat,
} from '../shared/daemonBridge';
import { log } from '../shared/log';

/**
 * Link to the korn daemon (daemon/, installed separately). Does nothing visible without it.
 * - Tells the daemon which folders this window has open (heartbeat), so it shows conflicts here
 *   instead of a macOS dialog.
 * - Shows the conflicts it reports for this window's repos, with a button that opens the file.
 */
export function watchDaemon(onEvent: () => void): vscode.Disposable {
	const folders = () => vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
	const beat = () => {
		try {
			writeHeartbeat(folders());
		} catch {
			// state folder not writable: the daemon falls back to its dialog
		}
	};
	beat();
	const timer = setInterval(beat, HEARTBEAT_MS);
	const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(beat);

	// Per window (not globalState, which other windows share): each window shows its own repos' events.
	// Older events were already shown by a dialog: the daemon only sends here while this window is open.
	let seen = lastEventId();
	const check = () => {
		const fresh = readEvents().filter((e) => e.id > seen);
		if (fresh.length === 0) {
			return;
		}
		seen = fresh[fresh.length - 1].id;
		onEvent(); // the panel's background sync section
		for (const event of fresh) {
			if (folders().some((folder) => folderShowsRepo(folder, event.repo))) {
				show(event);
			}
		}
	};
	watchFile(eventsFile(), { interval: 2000 }, check);
	check();

	return new vscode.Disposable(() => {
		clearInterval(timer);
		folderSub.dispose();
		unwatchFile(eventsFile(), check);
		removeHeartbeat();
	});
}

async function show(event: DaemonEvent) {
	log(`korn daemon: ${event.message}`);
	const button = event.button ?? 'เปิดดู';
	const choice = await vscode.window.showWarningMessage(`Korn — ${event.message}`, button, 'ไว้ก่อน');
	if (choice === button) {
		// a .r.md opens in Korn, which shows the Resolve tab while the file has conflict markers (policy "resolve")
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(event.file));
	}
}
