import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

// Minimal typings for VS Code's built-in Git extension API (extensions/git/src/api/git.d.ts)
interface Branch {
	readonly name?: string;
	readonly upstream?: { readonly remote: string; readonly name: string };
}
interface Repository {
	readonly rootUri: vscode.Uri;
	readonly state: { readonly HEAD: Branch | undefined };
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
	status(): Promise<void>;
}
interface GitAPI {
	getRepository(uri: vscode.Uri): Repository | null;
}

export interface SyncResult {
	committed: boolean;
	message?: string;
	time: Date;
}

async function getGitApi(): Promise<GitAPI> {
	const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
	if (!ext) {
		throw new Error('ไม่พบ Git extension ของ VS Code');
	}
	const exports = ext.isActive ? ext.exports : await ext.activate();
	return exports.getAPI(1);
}

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || error.message));
			} else {
				resolve(stdout);
			}
		});
	});
}

function formatDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Commit time of the newest commit touching this file that is already on the remote
// (git remembers this, so it survives reloads). undefined = never synced / no upstream.
export async function getLastSyncTime(uri: vscode.Uri): Promise<Date | undefined> {
	try {
		const out = await runGit(
			['log', '-1', '--format=%cI', '@{upstream}', '--', path.basename(uri.fsPath)],
			path.dirname(uri.fsPath)
		);
		return out.trim() ? new Date(out.trim()) : undefined;
	} catch {
		return undefined;
	}
}

// Save → git add → commit only this file → push
export async function syncFile(uri: vscode.Uri): Promise<SyncResult> {
	const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (document?.isDirty) {
		await document.save();
	}

	const git = await getGitApi();
	const repo = git.getRepository(uri);
	if (!repo) {
		throw new Error('ไฟล์นี้ไม่ได้อยู่ใน git repository');
	}

	const cwd = repo.rootUri.fsPath;
	const file = path.relative(cwd, uri.fsPath);
	const time = new Date();
	let message: string | undefined;

	const status = await runGit(['status', '--porcelain', '--', file], cwd);
	if (status.trim()) {
		message = `update ${path.basename(file)} - ${formatDate(time)}`;
		await runGit(['add', '--', file], cwd);
		// Pathspec = commit only this file, even if other files are staged
		await runGit(['commit', '-m', message, '--', file], cwd);
	}

	const head = repo.state.HEAD;
	if (head?.upstream) {
		await repo.push();
	} else {
		await repo.push('origin', head?.name, true);
	}
	await repo.status();

	return { committed: message !== undefined, message, time };
}
