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

// Undo "Resolve in Korn": back to before the merge (our commit, our other uncommitted files restored)
export async function abortMerge(cwd: string): Promise<void> {
	await runGit(['merge', '--abort'], cwd);
}

// 3. Resolve in Korn: start a normal merge and leave the conflict markers for the user.
// diff3 style adds the "|||||||" original section, shown as "Original" in the Resolve mode.
export async function startMerge(cwd: string): Promise<void> {
	try {
		await runGit(['-c', 'merge.conflictStyle=diff3', 'merge', '--no-edit', '--autostash', '@{upstream}'], cwd);
	} catch (error) {
		if (!(await operationInProgress(cwd))) {
			throw error; // failed for another reason than conflicts
		}
	}
}

export type FileSyncState = 'dirty' | 'ahead' | 'synced' | 'never';

export interface FileStatus {
	state: FileSyncState; // dirty = changed, not synced · ahead = committed, not pushed
	lastSync?: string; // ISO time of the newest commit of this file on the remote
	incoming?: boolean; // the remote has a newer version (known after a fetch)
}

/**
 * Sync status of every .r.md file in the repo, with 3 git calls in total (not one per file).
 * Keys are paths relative to the repo root with "/". Files not listed are "never" synced.
 */
export async function repoFileStates(cwd: string): Promise<Map<string, FileStatus>> {
	const states = new Map<string, FileStatus>();
	const noQuote = ['-c', 'core.quotepath=false']; // keep non-ASCII (e.g. Thai) names readable

	// Last synced: newest commit on the remote that touched each file
	if (await hasUpstream(cwd)) {
		const log = await runGit([...noQuote, 'log', '@{upstream}', '--format=%x01%cI', '--name-only', '--', '*.r.md'], cwd);
		let time = '';
		for (const line of log.split('\n')) {
			if (line.startsWith('\u0001')) {
				time = line.slice(1);
			} else if (line && !states.has(line)) {
				states.set(line, { state: 'synced', lastSync: time });
			}
		}
		// Committed but not pushed yet
		const ahead = await runGit([...noQuote, 'log', '@{upstream}..HEAD', '--format=', '--name-only', '--', '*.r.md'], cwd);
		for (const file of ahead.split('\n').filter(Boolean)) {
			states.set(file, { ...states.get(file), state: 'ahead' });
		}
		// Changed on the remote, not pulled yet (as of the last fetch)
		for (const file of await incomingFiles(cwd)) {
			const current = states.get(file);
			states.set(file, { ...current, state: current?.state ?? 'never', incoming: true });
		}
	}

	// Changed or untracked in the working tree (-z: NUL separated, "XY path")
	const status = await runGit(['status', '--porcelain', '-z', '--untracked-files=all', '--', '*.r.md'], cwd);
	const entries = status.split('\0');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) {
			continue;
		}
		const code = entry.slice(0, 2);
		states.set(entry.slice(3), { ...states.get(entry.slice(3)), state: 'dirty' });
		if (code.startsWith('R') || code.startsWith('C')) {
			i++; // a rename/copy is followed by its original path
		}
	}
	return states;
}

// .r.md files the remote changed that we haven't pulled (as of the last fetch)
export async function incomingFiles(cwd: string): Promise<string[]> {
	const out = await runGit(['-c', 'core.quotepath=false', 'log', 'HEAD..@{upstream}', '--format=', '--name-only', '--', '*.r.md'], cwd);
	return [...new Set(out.split('\n').filter(Boolean))];
}

export type PullResult = { pulled: boolean; conflictFile?: string; skipped?: string };

/**
 * Brings in the remote's new commits without pushing (auto-sync "get what others changed").
 * Skips when a file we changed but haven't committed is also changed on the remote:
 * git would have to stash it and could leave it hidden in the stash, so that file is
 * left to its own Sync (which commits it first and handles a conflict properly).
 */
export async function pullRemote(cwd: string): Promise<PullResult> {
	if (!(await hasUpstream(cwd)) || (await operationInProgress(cwd)) || (await behindCount(cwd)) === 0) {
		return { pulled: false };
	}
	const incoming = new Set(
		(await runGit(['-c', 'core.quotepath=false', 'diff', '--name-only', 'HEAD', '@{upstream}'], cwd)).split('\n').filter(Boolean)
	);
	const changed = await runGit(['-c', 'core.quotepath=false', 'diff', '--name-only', 'HEAD'], cwd);
	const untracked = await runGit(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'], cwd);
	const dirty = `${changed}\n${untracked}`.split('\n').filter(Boolean);
	const overlap = dirty.find((file) => incoming.has(file));
	if (overlap) {
		return { pulled: false, skipped: overlap };
	}
	const conflicted = await rebaseOntoUpstream(cwd);
	if (conflicted.length > 0) {
		return { pulled: false, conflictFile: conflicted[0] };
	}
	return { pulled: true };
}

export interface BranchInfo {
	branch?: string; // undefined when detached
	upstream?: string; // e.g. "origin/main"; undefined = not on the remote yet
	detached: boolean;
}

// Which branch Sync works on, and where it pushes to
export async function branchInfo(cwd: string): Promise<BranchInfo> {
	let branch: string;
	try {
		// works on a brand-new repo too (no commits yet), fails when HEAD is detached
		branch = (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd)).trim();
	} catch {
		return { detached: true };
	}
	let upstream: string | undefined;
	try {
		upstream = (await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], cwd)).trim();
	} catch {
		upstream = undefined;
	}
	return { branch, upstream, detached: false };
}
