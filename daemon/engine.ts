import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import * as path from 'path';
import { RepoBusyError, withRepoLock } from '../src/git/lock';
import * as ops from '../src/git/ops';
import { isIncluded, Policy, RepoConfig, settingsFor } from './config';
import { BUTTON_PICK, BUTTON_VIEW, conflictMessage, nextStep } from './messages';
import type { Notifier } from './notify';
import { log, readPaused, readState, RepoState, setPaused, writeRepoState } from './state';

// One sync round for one repo: commit files that have been quiet long enough → fetch →
// rebase onto the remote (settling conflicts by policy) → push. See docs/daemon.md.

export interface RoundOptions {
	now?: number; // for tests
	force?: boolean; // `korn sync`: ignore quietMinutes and pullEveryMinutes
	notify?: Notifier;
}

export interface RoundResult {
	committed: string[];
	pushed: boolean;
	pulled: boolean;
	resolved: { file: string; policy: Policy }[];
	paused: string[]; // newly paused because of a conflict
	merging: string[]; // conflict markers left to pick per conflict (policy "resolve")
	waiting: { file: string; readyAt: string }[];
	skipped?: string;
	error?: string;
}

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

function hasMarkers(file: string): boolean {
	try {
		return CONFLICT_MARKER.test(readFileSync(file, 'utf8'));
	} catch {
		return false; // deleted
	}
}

function mtimeOf(file: string): number {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}

// "notes.md" → "notes.conflict-20260930-1012.md", "note.r.md" → "note.conflict-20260930-1012.r.md"
// (next to it; -2, -3… if taken). Keeping ".r.md" means the copy still opens in Korn.
export function conflictCopyName(cwd: string, file: string, time: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${time.getFullYear()}${pad(time.getMonth() + 1)}${pad(time.getDate())}-${pad(time.getHours())}${pad(time.getMinutes())}`;
	const ext = file.endsWith('.r.md') ? '.r.md' : path.posix.extname(file);
	const base = file.slice(0, file.length - ext.length);
	for (let n = 1; ; n++) {
		const name = `${base}.conflict-${stamp}${n > 1 ? `-${n}` : ''}${ext}`;
		if (!existsSync(path.join(cwd, name))) {
			return name;
		}
	}
}

// Files with conflict markers already reported (so the log isn't repeated every round)
const warnedMarkers = new Set<string>();

export async function runRound(repo: RepoConfig, options: RoundOptions = {}): Promise<RoundResult> {
	const now = options.now ?? Date.now();
	const notify: Notifier = options.notify ?? { conflict: () => undefined, error: () => undefined };
	const name = path.basename(repo.path);
	const previous = readState()[repo.path] ?? {};
	const state: RepoState = { ...previous, lastRound: new Date(now).toISOString(), skipped: undefined, error: undefined };
	const result: RoundResult = { committed: [], pushed: false, pulled: false, resolved: [], paused: [], merging: [], waiting: [] };

	try {
		if (!existsSync(repo.path)) {
			throw new Error(`ไม่พบโฟลเดอร์ ${repo.path}`);
		}
		await withRepoLock(repo.path, 'daemon', () => round(repo, now, options.force ?? false, notify, state, result));
	} catch (error) {
		if (error instanceof RepoBusyError) {
			result.skipped = `${error.holder} is syncing`;
		} else {
			result.error = error instanceof Error ? error.message : String(error);
			log(`${name}: error — ${result.error}`);
			if (result.error !== previous.error) {
				notify.error(`Korn: ${name}`, result.error); // once, not every round
			}
		}
	}
	state.skipped = result.skipped;
	state.error = result.error;
	state.waiting = result.waiting;
	writeRepoState(repo.path, state);
	return result;
}

async function round(
	repo: RepoConfig,
	now: number,
	force: boolean,
	notify: Notifier,
	state: RepoState,
	result: RoundResult
) {
	const cwd = repo.path;
	const name = path.basename(cwd);
	// (realpath: /var → /private/var on macOS, symlinked folders)
	if (realpathSync((await ops.runGit(['rev-parse', '--show-toplevel'], cwd)).trim()) !== realpathSync(cwd)) {
		throw new Error(`${cwd} ไม่ใช่โฟลเดอร์บนสุดของ git repo`);
	}

	// A merge left for the user (policy "resolve", or "Resolve in Korn" in VS Code)
	const merging = await ops.pendingMerge(cwd);
	if (merging) {
		const open = merging.filter((file) => hasMarkers(path.join(cwd, file)));
		const notQuiet = merging.filter((file) => !force && mtimeOf(path.join(cwd, file)) + settingsFor(repo, file).quietMinutes * 60_000 > now);
		if (merging.length === 0 || open.length > 0 || notQuiet.length > 0) {
			// VS Code's "Finish & Sync" or `korn resolve` concludes it; we don't touch it meanwhile
			result.skipped = `waiting for the conflict to be resolved: ${(open.length ? open : merging).join(', ') || 'merge in progress'}`;
			return;
		}
		// every marker was removed by hand: conclude the merge, then sync as usual
		await ops.concludeMerge(cwd, merging);
		log(`${name}: concluded the merge of ${merging.join(', ')} (no conflict markers left)`);
	}

	if (await ops.operationInProgress(cwd)) {
		result.skipped = 'merge/rebase in progress';
		return;
	}
	const branch = await ops.branchInfo(cwd);
	state.branch = branch.branch;
	state.upstream = branch.upstream;
	if (branch.detached) {
		result.skipped = 'detached HEAD — checkout a branch';
		return;
	}

	// 1. Commit files that have been quiet long enough
	const paused = await readPaused(cwd);
	for (const file of await ops.changedFiles(cwd)) {
		if (!isIncluded(repo, file) || paused[file]) {
			continue;
		}
		const full = path.join(cwd, file);
		let mtime = 0; // deleted: ready now
		if (existsSync(full)) {
			mtime = statSync(full).mtimeMs;
			if (hasMarkers(full)) {
				if (!warnedMarkers.has(full)) {
					warnedMarkers.add(full);
					log(`${name}: ${file} has conflict markers (<<<<<<<), not committing it until they're gone`);
				}
				continue;
			}
			warnedMarkers.delete(full);
		}
		const readyAt = mtime + settingsFor(repo, file).quietMinutes * 60_000;
		if (!force && readyAt > now) {
			result.waiting.push({ file, readyAt: new Date(readyAt).toISOString() });
			continue;
		}
		if (await ops.commitFile(cwd, file, new Date(now))) {
			result.committed.push(file);
			log(`${name}: committed ${file}`);
		}
	}

	// 2. Exchange with the remote
	const conflictPaused = Object.entries(paused)
		.filter(([, p]) => p.reason === 'conflict')
		.map(([file]) => file);
	if (conflictPaused.length > 0) {
		result.skipped = `waiting for "korn resolve" on ${conflictPaused.join(', ')}`;
		return;
	}
	if (!(await ops.runGit(['remote'], cwd)).trim()) {
		result.skipped = 'no remote';
		return;
	}
	const pullDue =
		force || (repo.pullEveryMinutes > 0 && (!state.lastPull || now - Date.parse(state.lastPull) >= repo.pullEveryMinutes * 60_000));
	if (!pullDue && (await ops.aheadCount(cwd)) === 0) {
		return; // nothing to send, not time to get
	}

	await ops.fetchRemote(cwd);
	state.lastPull = new Date(now).toISOString();
	if ((await ops.hasUpstream(cwd)) && (await ops.behindCount(cwd)) > 0) {
		const overlap = await ops.uncommittedIncoming(cwd);
		if (overlap) {
			// commit it first (once quiet), then the rebase handles the conflict properly
			result.skipped = `${overlap} changed here and on the remote — syncing after it's committed`;
			return;
		}
		const conflicted = await ops.integrateAll(cwd);
		if (conflicted.length > 0) {
			const decisions = conflicted.map((file) => ({ file, policy: settingsFor(repo, file).conflict }));
			if (decisions.some((d) => d.policy === 'resolve')) {
				// Like "Resolve in Korn": merge and leave the markers (one merge holds every conflicted file)
				await ops.startMerge(cwd);
				result.merging = (await ops.pendingMerge(cwd)) ?? conflicted;
				const message = conflictMessage.ask(name, result.merging);
				log(message);
				notify.conflict(cwd, path.join(cwd, result.merging[0]), message, BUTTON_PICK);
				return;
			}
			const toPause = decisions.filter((d) => d.policy === 'pause');
			if (toPause.length > 0) {
				for (const { file } of toPause) {
					await setPaused(cwd, file, { reason: 'conflict', since: new Date(now).toISOString() });
					result.paused.push(file);
				}
				const message = conflictMessage.paused(name, toPause.map((d) => d.file));
				log(`${message} (${nextStep.paused(toPause[0].file)})`);
				notify.conflict(cwd, path.join(cwd, toPause[0].file), message, BUTTON_PICK);
				return;
			}
			const time = new Date(now);
			const copies = new Map<string, string>();
			await ops.resolveWith(cwd, decisions as { file: string; policy: ops.ConflictPolicy }[], time, (file) => {
				const copy = conflictCopyName(cwd, file, time);
				copies.set(file, copy);
				return copy;
			});
			result.resolved = decisions;
			for (const { file, policy } of decisions) {
				const copy = copies.get(file);
				const message =
					policy === 'saveCopy' && copy
						? conflictMessage.keepBoth(name, file, copy)
						: policy === 'keepTheirs'
							? conflictMessage.theirs(name, file)
							: conflictMessage.mine(name, file);
				log(message);
				const opens = path.join(cwd, copy ?? file); // "keep both": the copy, to see what was mine
				state.notices = [...(state.notices ?? []), { time: new Date(now).toISOString(), message, file: opens }].slice(-5);
				notify.conflict(cwd, opens, message, BUTTON_VIEW);
			}
		}
		result.pulled = true;
		log(`${name}: pulled remote changes`);
	}

	// 3. Push
	if ((await ops.aheadCount(cwd)) > 0) {
		await ops.pushCurrent(cwd);
		result.pushed = true;
		state.lastSync = new Date(now).toISOString();
		state.upstream = (await ops.branchInfo(cwd)).upstream;
		log(`${name}: pushed`);
	}
}

export type ResolveChoice = 'mine' | 'theirs' | 'copy';

/**
 * `korn resolve <files> --mine|--theirs|--copy`: settle files paused by a conflict (or paused by the user),
 * push, and unpause them. Returns what happened, for the CLI to print.
 */
export async function resolvePaused(repo: RepoConfig, files: string[], choice: ResolveChoice): Promise<string> {
	const cwd = repo.path;
	const policy: ops.ConflictPolicy = choice === 'mine' ? 'keepMine' : choice === 'theirs' ? 'keepTheirs' : 'saveCopy';
	return withRepoLock(
		cwd,
		'cli',
		async () => {
			const time = new Date();
			for (const file of files) {
				await ops.commitFile(cwd, file, time); // edits made while it was paused
			}
			let summary = 'nothing to resolve any more';
			if (await ops.hasUpstream(cwd)) {
				await ops.fetchRemote(cwd);
				if ((await ops.behindCount(cwd)) > 0) {
					const overlap = await ops.uncommittedIncoming(cwd);
					if (overlap) {
						throw new Error(`${overlap} มีการแก้ที่ยังไม่ commit และ remote ก็แก้ด้วย — รอให้ daemon commit ก่อน หรือใช้ korn sync`);
					}
					const conflicted = await ops.integrateAll(cwd);
					if (conflicted.length > 0) {
						const paused = await readPaused(cwd);
						const decisions = conflicted.map((file) => {
							if (files.includes(file)) {
								return { file, policy };
							}
							const configured = settingsFor(repo, file).conflict;
							if (paused[file] || configured === 'pause' || configured === 'resolve') {
								throw new Error(`${file} ก็ conflict ด้วย — ใส่ไว้ในคำสั่งเดียวกัน: korn resolve ${[...files, file].join(' ')} --${choice}`);
							}
							return { file, policy: configured as ops.ConflictPolicy };
						});
						summary = await ops.resolveWith(cwd, decisions, time, (file) => conflictCopyName(cwd, file, time));
					} else {
						summary = 'merged without conflicts';
					}
				}
			}
			if ((await ops.aheadCount(cwd)) > 0 && (await ops.runGit(['remote'], cwd)).trim()) {
				await ops.pushCurrent(cwd);
				summary += ' · pushed';
				const state = readState()[cwd] ?? {};
				writeRepoState(cwd, { ...state, lastSync: time.toISOString(), skipped: undefined, error: undefined });
			}
			for (const file of files) {
				await setPaused(cwd, file, undefined);
			}
			log(`${path.basename(cwd)}: resolve ${files.join(', ')} --${choice}: ${summary}`);
			return summary;
		},
		20_000
	);
}

/**
 * Finish a merge left by policy "resolve" (`korn resolve <file>` in a terminal): write the picked
 * text of each file; once no unmerged file has markers left, conclude the merge and push.
 * Returns what happened, for the CLI to print.
 */
export async function finishMergeResolve(repo: RepoConfig, writes: { file: string; text: string }[]): Promise<string> {
	const cwd = repo.path;
	return withRepoLock(
		cwd,
		'cli',
		async () => {
			const unmerged = await ops.pendingMerge(cwd);
			if (!unmerged) {
				throw new Error('ไม่มี merge ที่รอเลือกอยู่ (อาจถูกจัดการใน VS Code ไปแล้ว)');
			}
			for (const { file, text } of writes) {
				writeFileSync(path.join(cwd, file), text);
			}
			const left = unmerged.filter((file) => hasMarkers(path.join(cwd, file)));
			if (left.length > 0) {
				return `บันทึกแล้ว ยังเหลือ conflict ใน ${left.join(', ')} — korn resolve ${left[0]}`;
			}
			await ops.concludeMerge(cwd, unmerged);
			let summary = `merged ${unmerged.join(', ')}`;

			// someone may have pushed again meanwhile: merge (not rebase, so the merge commit stays)
			if (await ops.hasUpstream(cwd)) {
				await ops.fetchRemote(cwd);
				if ((await ops.behindCount(cwd)) > 0 && (await ops.integrate(cwd, unmerged[0], true)) === 'conflict') {
					await ops.startMerge(cwd);
					return `${summary} · มีคนแก้ ${unmerged[0]} อีกระหว่างนี้ — korn resolve ${unmerged[0]} อีกครั้ง`;
				}
			}
			if ((await ops.aheadCount(cwd)) > 0 && (await ops.runGit(['remote'], cwd)).trim()) {
				await ops.pushCurrent(cwd);
				summary += ' · pushed';
				const state = readState()[cwd] ?? {};
				writeRepoState(cwd, { ...state, lastSync: new Date().toISOString(), skipped: undefined, error: undefined });
			}
			log(`${path.basename(cwd)}: korn resolve: ${summary}`);
			return summary;
		},
		20_000
	);
}
