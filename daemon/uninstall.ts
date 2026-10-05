import { existsSync, rmdirSync, rmSync } from 'fs';
import { createInterface } from 'node:readline/promises';
import * as path from 'path';
import { runGit } from '../src/git/ops';
import { configPath, loadConfig, stateDir } from './config';
import { installDir, stopService } from './service';

// `korn uninstall`: stop background sync and remove what korn left on this machine, then say how to
// remove the command itself (package managers don't run anything when a package is removed).
// The notes and their git history are never touched.

/** How this korn was installed, from where korn.js lives; undefined = VS Code's copy or a dev build */
export function removeCommand(script: string): string | undefined {
	const p = script.split(path.sep).join('/');
	if (/\/Cellar\/korn\//.test(p) || /\/opt\/korn\//.test(p)) {
		return 'brew uninstall korn';
	}
	if (/\/pnpm\//i.test(p)) {
		return 'pnpm remove -g korn-sync';
	}
	if (/\/\.bun\//.test(p)) {
		return 'bun remove -g korn-sync';
	}
	if (/\/yarn\//i.test(p) || /\/\.yarn\//.test(p)) {
		return 'yarn global remove korn-sync';
	}
	if (/\/node_modules\/korn-sync\//.test(p)) {
		return 'npm uninstall -g korn-sync';
	}
	return undefined;
}

export async function uninstall(script: string, args: string[]): Promise<number> {
	// 1. background service off (also what starts it at login)
	const wasOn = stopService();
	console.log(wasOn ? '✓ หยุด sync เบื้องหลังแล้ว' : '✓ sync เบื้องหลังไม่ได้เปิดอยู่');

	// 2. settings and logs: --all removes them, --keep-config keeps them, otherwise ask (keep when not asked)
	let removeData = args.includes('--all');
	if (!removeData && !args.includes('--keep-config') && process.stdin.isTTY) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = (await rl.question('ลบการตั้งค่า (repo ที่ตั้งไว้) และ log ด้วยไหม? [y/N] ')).trim().toLowerCase();
			removeData = answer.startsWith('y');
		} finally {
			rl.close();
		}
	}

	// the copy the service ran: useless once it's stopped
	rmSync(installDir(), { recursive: true, force: true });

	if (removeData) {
		// files korn keeps inside each repo's .git (paused files, a lock left by a crash)
		try {
			for (const repo of loadConfig().repos) {
				for (const name of ['korn-paused.json', 'korn.lock']) {
					const file = await runGit(['rev-parse', '--git-path', name], repo.path).then((s) => path.resolve(repo.path, s.trim()), () => '');
					if (file) {
						rmSync(file, { force: true });
					}
				}
			}
		} catch {
			// no config or a repo is gone: nothing more to clean
		}
		rmSync(configPath(), { force: true });
		try {
			rmdirSync(path.dirname(configPath())); // ~/.config/korn, if nothing else is in it
		} catch {
			// not empty, or already gone
		}
		rmSync(stateDir(), { recursive: true, force: true });
		console.log('✓ ลบการตั้งค่าและ log แล้ว');
	} else if (existsSync(configPath())) {
		console.log(`การตั้งค่ายังอยู่ที่ ${configPath()} (ลบทั้งหมด: korn uninstall --all)`);
	}
	console.log('โน้ตและ git history ใน repo ไม่ได้ถูกแตะ');

	// 3. the command itself
	const remove = removeCommand(script);
	console.log(
		remove
			? `\nขั้นสุดท้าย ถอนคำสั่ง korn:\n  ${remove}`
			: '\nถ้าใช้จาก VS Code: เอาติ๊ก "Sync เบื้องหลัง" ออก หรือถอน extension ได้เลย'
	);
	return 0;
}
