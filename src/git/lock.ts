import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'fs';
import * as path from 'path';
import { runGit } from './ops';

// One sync at a time per repo, across processes: the VS Code extension and the korn daemon
// both take .git/korn.lock before touching git. (No vscode import: used by both.)

interface LockInfo {
	pid: number;
	owner: string; // "extension" | "daemon" | "cli"
	time: number;
}

// A lock older than this is treated as left over from a crash
const STALE_MS = 10 * 60 * 1000;

export async function lockPath(cwd: string): Promise<string> {
	return path.resolve(cwd, (await runGit(['rev-parse', '--git-path', 'korn.lock'], cwd)).trim());
}

function readLock(file: string): LockInfo | undefined {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
	}
}

function tryAcquire(file: string, owner: string): boolean {
	try {
		const fd = openSync(file, 'wx');
		writeSync(fd, JSON.stringify({ pid: process.pid, owner, time: Date.now() } satisfies LockInfo));
		closeSync(fd);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
	}
	const holder = readLock(file);
	if (!holder || !alive(holder.pid) || Date.now() - holder.time > STALE_MS) {
		rmSync(file, { force: true }); // left over: take it over
		return tryAcquire(file, owner);
	}
	return false;
}

/** Who holds the lock right now (undefined = free or stale) */
export async function lockHolder(cwd: string): Promise<LockInfo | undefined> {
	const holder = readLock(await lockPath(cwd));
	return holder && alive(holder.pid) && Date.now() - holder.time <= STALE_MS ? holder : undefined;
}

export class RepoBusyError extends Error {
	constructor(readonly holder: string) {
		super(holder === 'daemon' ? 'korn daemon กำลัง sync repo นี้อยู่ ลองใหม่อีกครั้งในไม่กี่วินาที' : `repo นี้กำลังถูก sync โดย ${holder}`);
	}
}

/**
 * Run `work` holding the repo lock. Waits up to `waitMs` for another process to finish,
 * then throws RepoBusyError. The same process may nest calls (e.g. sync → resolve).
 */
export async function withRepoLock<T>(cwd: string, owner: string, work: () => Promise<T>, waitMs = 0): Promise<T> {
	const file = await lockPath(cwd);
	if (!users.has(file)) {
		const deadline = Date.now() + waitMs;
		// (users.has: another call in this process took it while we waited — share it)
		while (!users.has(file) && !tryAcquire(file, owner)) {
			if (Date.now() >= deadline) {
				throw new RepoBusyError(readLock(file)?.owner ?? 'another process');
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	users.set(file, (users.get(file) ?? 0) + 1);
	try {
		return await work();
	} finally {
		const left = (users.get(file) ?? 1) - 1;
		if (left > 0) {
			users.set(file, left);
		} else {
			users.delete(file);
			rmSync(file, { force: true });
		}
	}
}

// How many calls in this process are inside withRepoLock, per lock file (released at 0)
const users = new Map<string, number>();
