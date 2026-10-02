import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';

// How the korn daemon (daemon/) and the VS Code extension talk, through files in the state folder.
// No vscode import: used by both.
// - vscode/<pid>.json  heartbeat of each VS Code window: which folders it has open
// - events.jsonl       conflicts the daemon wants VS Code to show (one JSON per line)

/** ~/.local/state/korn (or $KORN_STATE_DIR, or $XDG_STATE_HOME/korn) */
export function stateDir(): string {
	return process.env.KORN_STATE_DIR ?? path.join(process.env.XDG_STATE_HOME ?? path.join(homedir(), '.local', 'state'), 'korn');
}

function isInside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** The repo and the window overlap: the window shows the repo, or a folder inside it */
export function folderShowsRepo(folder: string, repo: string): boolean {
	return isInside(path.resolve(folder), path.resolve(repo)) || isInside(path.resolve(repo), path.resolve(folder));
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

// ---- Heartbeat (written by the extension, read by the daemon) ----

export const HEARTBEAT_MS = 30_000;
const HEARTBEAT_STALE_MS = 90_000;

interface Heartbeat {
	pid: number;
	folders: string[];
	time: number;
}

function heartbeatFile(pid = process.pid): string {
	return path.join(stateDir(), 'vscode', `${pid}.json`);
}

export function writeHeartbeat(folders: string[]) {
	const file = heartbeatFile();
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ pid: process.pid, folders, time: Date.now() } satisfies Heartbeat));
}

export function removeHeartbeat() {
	rmSync(heartbeatFile(), { force: true });
}

/** Is a VS Code window (with the Korn extension) showing this repo right now? */
export function vscodeShowsRepo(repo: string, now = Date.now()): boolean {
	const dir = path.join(stateDir(), 'vscode');
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	for (const name of names) {
		let beat: Heartbeat;
		try {
			beat = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
		} catch {
			continue;
		}
		if (now - beat.time > HEARTBEAT_STALE_MS || !alive(beat.pid)) {
			rmSync(path.join(dir, name), { force: true }); // window closed without cleaning up
			continue;
		}
		if (beat.folders.some((folder) => folderShowsRepo(folder, repo))) {
			return true;
		}
	}
	return false;
}

// ---- Events (written by the daemon, shown by the extension) ----

export interface DaemonEvent {
	id: number; // increasing
	time: string;
	repo: string;
	file: string; // absolute
	message: string;
	button?: string; // label of the button that opens `file`
}

const MAX_EVENTS = 50;

export function eventsFile(): string {
	return path.join(stateDir(), 'events.jsonl');
}

export function readEvents(): DaemonEvent[] {
	try {
		return readFileSync(eventsFile(), 'utf8')
			.split('\n')
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as DaemonEvent];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

export function appendEvent(event: Omit<DaemonEvent, 'id' | 'time'>): DaemonEvent {
	const events = readEvents();
	const last = events[events.length - 1]?.id ?? 0;
	const full: DaemonEvent = { id: Math.max(Date.now(), last + 1), time: new Date().toISOString(), ...event };
	const kept = [...events, full].slice(-MAX_EVENTS);
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${eventsFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
	renameSync(tmp, eventsFile()); // atomic: the extension never reads half a file
	return full;
}

export function lastEventId(): number {
	const events = readEvents();
	return events[events.length - 1]?.id ?? 0;
}
