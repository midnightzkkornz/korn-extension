import * as path from 'path';
import * as vscode from 'vscode';
import * as ops from './gitOps';

// Minimal typings for VS Code's built-in Git extension API (extensions/git/src/api/git.d.ts)
interface Branch {
	readonly name?: string;
	readonly upstream?: { readonly remote: string; readonly name: string };
}
interface Repository {
	readonly rootUri: vscode.Uri;
	readonly state: { readonly HEAD: Branch | undefined };
	fetch(): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
	status(): Promise<void>;
}
interface GitAPI {
	getRepository(uri: vscode.Uri): Repository | null;
}

export type SyncOutcome =
	| { kind: 'synced'; committed: boolean; message?: string; time: Date }
	| { kind: 'conflict'; file: string };

export type ConflictAction = 'keepMine' | 'saveCopy' | 'resolve';

async function getGitApi(): Promise<GitAPI> {
	const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
	if (!ext) {
		throw new Error('ไม่พบ Git extension ของ VS Code');
	}
	const exports = ext.isActive ? ext.exports : await ext.activate();
	return exports.getAPI(1);
}

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
	return { repo, cwd, file: path.relative(cwd, uri.fsPath) };
}

// Push through VS Code's Git extension, so it uses the same login/credentials as VS Code
async function push(repo: Repository) {
	await repo.status(); // pick up commits made with the git CLI
	const head = repo.state.HEAD;
	if (head?.upstream) {
		await repo.push();
	} else {
		await repo.push('origin', head?.name, true);
	}
	await repo.status();
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
	if (await ops.operationInProgress(cwd)) {
		if (action === 'resolve') {
			return undefined; // merge already started, just show it again
		}
		throw new Error('มี merge/rebase ค้างอยู่ แก้ใน Source Control ให้เสร็จก่อน');
	}
	await repo.fetch();
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
			return undefined; // the user finishes the merge in Source Control
	}
}
