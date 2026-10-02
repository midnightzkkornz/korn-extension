import * as path from 'path';
import * as vscode from 'vscode';
import type { ConflictAction } from '../shared/protocol';
import { getGitApi, push, Repository } from './api';
import { RepoBusyError, withRepoLock } from './lock';
import * as ops from './ops';

export type { ConflictAction };

// Sync, conflicts and pull for one .r.md: ops.ts does the git work, api.ts does fetch/push

export type SyncOutcome =
	| { kind: 'synced'; committed: boolean; message?: string; time: Date }
	| { kind: 'conflict'; file: string }
	// nothing to resolve any more (already handled, or the remote has nothing new)
	| { kind: 'noConflict' };

async function openRepo(uri: vscode.Uri): Promise<{ repo: Repository; cwd: string; file: string }> {
	const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (document?.isDirty) {
		await document.save();
	}
	const repo = (await getGitApi()).getRepository(uri);
	if (!repo) {
		throw new Error('ไฟล์นี้ไม่ได้อยู่ใน git repository');
	}
	const cwd = repo.rootUri.fsPath;
	// No branch = nothing to commit onto or push to
	if ((await ops.branchInfo(cwd)).detached) {
		throw new Error('อยู่ใน detached HEAD — checkout branch ก่อนแล้วค่อย Sync');
	}
	return { repo, cwd, file: path.relative(cwd, uri.fsPath) };
}

// Fetch through VS Code's Git extension (same login as VS Code); silent if offline
export async function fetchRepo(root: string): Promise<boolean> {
	try {
		const repo = (await getGitApi()).getRepository(vscode.Uri.file(root));
		if (!repo || !(await ops.hasUpstream(root))) {
			return false;
		}
		await repo.fetch();
		return true;
	} catch {
		return false;
	}
}

// Bring in what others pushed (no push). See ops.pullRemote for when it skips.
export async function pullRepo(root: string): Promise<ops.PullResult> {
	let result: ops.PullResult;
	try {
		result = await withRepoLock(root, 'extension', () => ops.pullRemote(root));
	} catch (error) {
		if (error instanceof RepoBusyError) {
			return { pulled: false, busy: error.holder }; // the daemon is syncing it, try next round
		}
		throw error;
	}
	if (result.pulled) {
		await (await getGitApi()).getRepository(vscode.Uri.file(root))?.status();
	}
	return result;
}

// Branch of the repo holding this file (undefined = not in a git repo)
export async function getBranchInfo(uri: vscode.Uri): Promise<ops.BranchInfo | undefined> {
	try {
		const cwd = (await ops.runGit(['rev-parse', '--show-toplevel'], path.dirname(uri.fsPath))).trim();
		return await ops.branchInfo(cwd);
	} catch {
		return undefined;
	}
}

export async function getMergeState(uri: vscode.Uri): Promise<ops.MergeState> {
	try {
		const cwd = (await ops.runGit(['rev-parse', '--show-toplevel'], path.dirname(uri.fsPath))).trim();
		return await ops.mergeState(cwd, path.relative(cwd, uri.fsPath));
	} catch {
		return 'none'; // not a git repo
	}
}

// Commit time of the newest commit touching this file that is already on the remote
// (git remembers this, so it survives reloads). undefined = never synced / no upstream.
export async function getLastSyncTime(uri: vscode.Uri): Promise<Date | undefined> {
	try {
		const out = await ops.runGit(
			['log', '-1', '--format=%cI', '@{upstream}', '--', path.basename(uri.fsPath)],
			path.dirname(uri.fsPath)
		);
		return out.trim() ? new Date(out.trim()) : undefined;
	} catch {
		return undefined;
	}
}

// Save → commit only this file → bring in remote changes → push.
// Returns kind 'conflict' when the remote changed the same lines of this file.
export async function syncFile(uri: vscode.Uri): Promise<SyncOutcome> {
	const { repo, cwd, file } = await openRepo(uri);
	// the korn daemon (daemon/) may be syncing the same repo: wait for it
	return withRepoLock(cwd, 'extension', () => syncLocked(repo, cwd, file), LOCK_WAIT_MS);
}

// Wait this long for the korn daemon to finish before giving up with "busy"
const LOCK_WAIT_MS = 20_000;

async function syncLocked(repo: Repository, cwd: string, file: string): Promise<SyncOutcome> {
	const time = new Date();
	let message: string | undefined;
	let merged = false;

	switch (await ops.mergeState(cwd, file)) {
		case 'rebase':
			throw new Error('มี rebase ค้างอยู่ แก้ใน Source Control ให้เสร็จก่อน แล้วค่อยกด Sync อีกครั้ง');
		case 'unresolved':
			throw new Error(`ยังมี conflict ที่ต้องแก้ใน ${path.basename(file)} (บรรทัด <<<<<<< / >>>>>>>) แก้ให้เสร็จแล้วกด Sync อีกครั้ง`);
		case 'resolved':
			// Conflict fixed after "Resolve conflict": Sync concludes the merge, no need to press Continue
			await ops.finishMerge(cwd, file);
			message = `merge ${path.basename(file)}`;
			merged = true;
			break;
		case 'none':
			message = await ops.commitFile(cwd, file, time);
			break;
	}

	if (await ops.hasUpstream(cwd)) {
		await repo.fetch();
		if ((await ops.behindCount(cwd)) > 0 && (await ops.integrate(cwd, file, merged)) === 'conflict') {
			await repo.status();
			return { kind: 'conflict', file };
		}
	}

	await push(repo);
	return { kind: 'synced', committed: message !== undefined, message, time };
}

// Handle a conflict found by syncFile (the 3 choices from the design)
export async function resolveConflict(uri: vscode.Uri, action: ConflictAction, copyName?: string): Promise<SyncOutcome | undefined> {
	const { repo, cwd, file } = await openRepo(uri);
	return withRepoLock(cwd, 'extension', () => resolveLocked(repo, cwd, file, action, copyName), LOCK_WAIT_MS);
}

async function resolveLocked(
	repo: Repository,
	cwd: string,
	file: string,
	action: ConflictAction,
	copyName?: string
): Promise<SyncOutcome | undefined> {
	const state = await ops.mergeState(cwd, file);
	if (state === 'rebase') {
		throw new Error('มี rebase ค้างอยู่ แก้ใน Source Control ให้เสร็จก่อน');
	}
	const merging = state === 'unresolved' || state === 'resolved';

	if (action === 'resolve' && merging) {
		return undefined; // "Resolve in Korn" already started, just show it again
	}
	if (action === 'cancel') {
		if (merging) {
			await ops.abortMerge(cwd);
			await repo.status();
		}
		return undefined;
	}
	if (merging) {
		// switching from "Resolve in Korn" to option 1 or 2 (the caller already asked to confirm)
		await ops.abortMerge(cwd);
	}

	await repo.fetch();
	if ((await ops.behindCount(cwd)) === 0) {
		await repo.status();
		return { kind: 'noConflict' };
	}
	const time = new Date();

	switch (action) {
		case 'keepMine': {
			const message = await ops.keepMine(cwd, file, time);
			await push(repo);
			return { kind: 'synced', committed: message !== undefined, message, time };
		}
		case 'saveCopy': {
			const copy = path.join(path.dirname(file), copyName ?? `${path.basename(file, '.r.md')}-copy.r.md`);
			const message = await ops.saveCopy(cwd, file, copy, time);
			await push(repo);
			return { kind: 'synced', committed: true, message, time };
		}
		case 'resolve':
			await ops.startMerge(cwd);
			await repo.status();
			return undefined; // the user finishes it in the Resolve tab, then Sync pushes
	}
}
