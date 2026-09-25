import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

// Plain git CLI steps used by Sync (no vscode import, so they can be tested outside VS Code).
// `cwd` is the repo root and `file` a path relative to it.

export function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{ cwd, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' } },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr.trim() || error.message));
				} else {
					resolve(stdout);
				}
			}
		);
	});
}

export function formatDate(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// git always prints repo paths with "/"
function gitPath(file: string): string {
	return file.split(path.sep).join('/');
}

// Commit only this file (other staged/modified files are left alone). Returns the message, or undefined if unchanged.
export async function commitFile(cwd: string, file: string, time: Date, suffix = ''): Promise<string | undefined> {
	const status = await runGit(['status', '--porcelain', '--', file], cwd);
	if (!status.trim()) {
		return undefined;
	}
	const message = `update ${path.basename(file)} - ${formatDate(time)}${suffix}`;
	await runGit(['add', '--', file], cwd);
	await runGit(['commit', '-m', message, '--', file], cwd);
	return message;
}

// A merge or rebase is still waiting to be finished
export async function operationInProgress(cwd: string): Promise<boolean> {
	for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
		const p = (await runGit(['rev-parse', '--git-path', name], cwd)).trim();
		if (existsSync(path.resolve(cwd, p))) {
			return true;
		}
	}
	return false;
}

async function gitDirHas(cwd: string, name: string): Promise<boolean> {
	const p = (await runGit(['rev-parse', '--git-path', name], cwd)).trim();
	return existsSync(path.resolve(cwd, p));
}

export type MergeState = 'none' | 'rebase' | 'unresolved' | 'resolved';

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

// Where this file stands in an unfinished merge (started by "Resolve conflict")
export async function mergeState(cwd: string, file: string): Promise<MergeState> {
	if (!(await gitDirHas(cwd, 'MERGE_HEAD'))) {
		return (await gitDirHas(cwd, 'rebase-merge')) || (await gitDirHas(cwd, 'rebase-apply')) ? 'rebase' : 'none';
	}
	let content = '';
	try {
		content = readFileSync(path.join(cwd, file), 'utf8');
	} catch {
		// deleted file: nothing to check
	}
	if (CONFLICT_MARKER.test(content)) {
		return 'unresolved';
	}
	// Other files still waiting to be resolved also block finishing the merge
	const others = (await conflictedFiles(cwd)).filter((f) => f !== gitPath(file));
	return others.length > 0 ? 'unresolved' : 'resolved';
}

// Conclude the merge (what the "Continue" button in Source Control does)
export async function finishMerge(cwd: string, file: string): Promise<void> {
	await runGit(['add', '--', file], cwd);
	await runGit(['commit', '--no-edit'], cwd);
}

export async function hasUpstream(cwd: string): Promise<boolean> {
	try {
		await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd);
		return true;
	} catch {
		return false;
	}
}

// How many commits the remote has that we don't
export async function behindCount(cwd: string): Promise<number> {
	return Number((await runGit(['rev-list', '--count', 'HEAD..@{upstream}'], cwd)).trim());
}

async function conflictedFiles(cwd: string): Promise<string[]> {
	const out = await runGit(['diff', '--name-only', '--diff-filter=U'], cwd);
	return out.split('\n').filter(Boolean);
}

// Rebase our local commits on top of the remote. On failure the repo is restored and the
// conflicted files are returned (empty array = success).
async function rebaseOntoUpstream(cwd: string, extraArgs: string[] = []): Promise<string[]> {
	try {
		await runGit(['rebase', '--autostash', ...extraArgs, '@{upstream}'], cwd);
		return [];
	} catch (error) {
		const conflicted = await conflictedFiles(cwd).catch(() => []);
		await runGit(['rebase', '--abort'], cwd).catch(() => undefined);
		if (conflicted.length === 0) {
			throw error;
		}
		return conflicted;
	}
}

// Like rebaseOntoUpstream, but with a merge (keeps an existing merge commit intact)
async function mergeUpstream(cwd: string): Promise<string[]> {
	try {
		await runGit(['merge', '--no-edit', '--autostash', '@{upstream}'], cwd);
		return [];
	} catch (error) {
		const conflicted = await conflictedFiles(cwd).catch(() => []);
		await runGit(['merge', '--abort'], cwd).catch(() => undefined);
		if (conflicted.length === 0) {
			throw error;
		}
		return conflicted;
	}
}

// Bring in remote commits automatically. Returns 'conflict' when git can't merge *this* file.
// useMerge: right after concluding a merge, so the merge commit isn't flattened by a rebase.
export async function integrate(cwd: string, file: string, useMerge = false): Promise<'ok' | 'conflict'> {
	const conflicted = useMerge ? await mergeUpstream(cwd) : await rebaseOntoUpstream(cwd);
	if (conflicted.length === 0) {
		return 'ok';
	}
	if (conflicted.includes(gitPath(file))) {
		return 'conflict';
	}
	throw new Error(`รวมกับ remote ไม่ได้ เพราะไฟล์อื่นมี conflict: ${conflicted.join(', ')}`);
}

async function showFile(cwd: string, rev: string, file: string): Promise<string | undefined> {
	try {
		return await runGit(['show', `${rev}:${gitPath(file)}`], cwd);
	} catch {
		return undefined;
	}
}

async function rebaseOrThrow(cwd: string, extraArgs: string[]) {
	const conflicted = await rebaseOntoUpstream(cwd, extraArgs);
	if (conflicted.length > 0) {
		throw new Error(`รวมกับ remote ไม่ได้: ${conflicted.join(', ')}`);
	}
}

// 1. Replace with my version: the file ends up exactly as we committed it
export async function keepMine(cwd: string, file: string, time: Date): Promise<string | undefined> {
	const mine = await showFile(cwd, 'HEAD', file);
	// In a rebase, -X theirs = prefer the commits being replayed (ours)
	await rebaseOrThrow(cwd, ['-X', 'theirs']);
	if (mine !== undefined) {
		writeFileSync(path.join(cwd, file), mine);
	}
	return commitFile(cwd, file, time);
}

// 2. Save my work as copy: the file takes the remote version, ours goes to `copy`
export async function saveCopy(cwd: string, file: string, copy: string, time: Date): Promise<string> {
	const mine = (await showFile(cwd, 'HEAD', file)) ?? '';
	const theirs = await showFile(cwd, '@{upstream}', file);
	// -X ours = prefer the remote side
	await rebaseOrThrow(cwd, ['-X', 'ours']);
	if (theirs !== undefined) {
		writeFileSync(path.join(cwd, file), theirs);
	}
	writeFileSync(path.join(cwd, copy), mine);

	const message = `update ${path.basename(file)} - ${formatDate(time)} (my version saved as ${path.basename(copy)})`;
	await runGit(['add', '--', file, copy], cwd);
	await runGit(['commit', '-m', message, '--', file, copy], cwd);
	return message;
}

// 3. Resolve conflict: start a normal merge and leave the conflict markers for the user
export async function startMerge(cwd: string): Promise<void> {
	try {
		await runGit(['merge', '--no-edit', '--autostash', '@{upstream}'], cwd);
	} catch (error) {
		if (!(await operationInProgress(cwd))) {
			throw error; // failed for another reason than conflicts
		}
	}
}
