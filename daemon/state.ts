import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import * as path from 'path';
import { formatDate, runGit } from '../src/git/ops';
import { stateDir } from './config';

// What the daemon knows between rounds, and what `korn status` / `korn log` show.
// - state.json (state dir): last round of each repo, written by the daemon
// - <repo>/.git/korn-paused.json: files not synced until the user says so (written under the repo lock)
// - korn.log (state dir): one line per action

export interface RepoState {
	lastRound?: string; // ISO times
	lastSync?: string; // last successful push
	lastPull?: string;
	branch?: string;
	upstream?: string;
	waiting?: { file: string; readyAt: string }[]; // changed, commit once quiet
	skipped?: string; // why the last round didn't sync (lock, merge in progress, detached HEAD…)
	error?: string;
	// conflicts settled automatically (keep both / mine / theirs), newest last, to show in `korn` and VS Code
	notices?: { time: string; message: string; file: string }[];
}

export interface Paused {
	reason: 'user' | 'conflict';
	since: string;
	detail?: string;
}

function stateFile(): string {
	return path.join(stateDir(), 'state.json');
}

export function readState(): Record<string, RepoState> {
	try {
		return JSON.parse(readFileSync(stateFile(), 'utf8'));
	} catch {
		return {};
	}
}

export function writeRepoState(repo: string, state: RepoState) {
	const all = readState();
	all[repo] = state;
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${stateFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(all, null, 2));
	renameSync(tmp, stateFile()); // atomic: `korn status` never reads half a file
}

// ---- Paused files (per repo, inside .git so it travels with the clone and not with commits) ----

async function pausedFile(repo: string): Promise<string> {
	return path.resolve(repo, (await runGit(['rev-parse', '--git-path', 'korn-paused.json'], repo)).trim());
}

export async function readPaused(repo: string): Promise<Record<string, Paused>> {
	try {
		return JSON.parse(readFileSync(await pausedFile(repo), 'utf8'));
	} catch {
		return {};
	}
}

export async function setPaused(repo: string, file: string, paused: Paused | undefined) {
	const all = await readPaused(repo);
	if (paused) {
		all[file] = paused;
	} else {
		delete all[file];
	}
	const target = await pausedFile(repo);
	if (Object.keys(all).length === 0) {
		rmSync(target, { force: true });
	} else {
		writeFileSync(target, JSON.stringify(all, null, 2));
	}
}

// ---- Log ----

const MAX_LOG_BYTES = 1024 * 1024;

export function logFile(): string {
	return path.join(stateDir(), 'korn.log');
}

export function log(message: string) {
	const file = logFile();
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
			renameSync(file, `${file}.1`); // keep one old log
		}
		const now = new Date();
		const time = `${formatDate(now)}:${String(now.getSeconds()).padStart(2, '0')}`; // local time
		appendFileSync(file, `${time} ${message}\n`);
	} catch {
		// logging must never stop a sync
	}
	if (process.env.KORN_LOG_STDOUT === '1') {
		console.log(message);
	}
}

// ---- Daemon pid (for `korn status`) ----

function pidFile(): string {
	return path.join(stateDir(), 'daemon.pid');
}

/** pid + the version of korn the daemon runs (`korn` compares it with the installed one after an upgrade) */
export function writePid(version: string) {
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(pidFile(), String(process.pid));
	writeFileSync(path.join(stateDir(), 'daemon.version'), version);
}

export function daemonVersion(): string | undefined {
	try {
		return readFileSync(path.join(stateDir(), 'daemon.version'), 'utf8').trim();
	} catch {
		return undefined;
	}
}

export function clearPid() {
	try {
		if (readFileSync(pidFile(), 'utf8').trim() === String(process.pid)) {
			rmSync(pidFile());
		}
	} catch {
		// already gone
	}
}

/** pid of the running daemon, or undefined */
export function daemonPid(): number | undefined {
	try {
		const pid = Number(readFileSync(pidFile(), 'utf8').trim());
		process.kill(pid, 0);
		return pid;
	} catch {
		return undefined;
	}
}
