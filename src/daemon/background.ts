import { execFile } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runGit } from '../git/ops';
import type { BackgroundRepo, BackgroundView, ConflictPreset, FrequencyPreset } from '../shared/protocol';
import { stateDir } from '../shared/daemonBridge';

// "Background sync" in the Korn panel: runs the korn CLI bundled with the extension (out/korn.js,
// built from daemon/) so the daemon can be turned on and set up without a terminal, brew or yaml.

// The parts of `korn status --json` used here (daemon/overview.ts)
interface Overview {
	running: boolean;
	service: boolean;
	configError?: string;
	repos: {
		path: string;
		conflict: ConflictPreset | 'custom';
		frequency: FrequencyPreset | 'custom';
		lastSync?: string;
		waiting: unknown[];
		needsChoice: { file: string; path: string }[];
		notices: { message: string; file: string }[];
		problem?: string;
	}[];
}

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export class Background {
	private busy = false;

	constructor(private readonly extensionUri: vscode.Uri) {}

	get script(): string {
		return vscode.Uri.joinPath(this.extensionUri, 'out', 'korn.js').fsPath;
	}

	/** Run `korn <args>` with VS Code's own runtime (no node install needed) */
	run(args: string[]): Promise<string> {
		const env = {
			...process.env,
			ELECTRON_RUN_AS_NODE: '1',
			PATH: [process.env.PATH ?? '', ...EXTRA_PATH].join(path.delimiter), // git, when VS Code was opened from the Dock
		};
		return new Promise((resolve, reject) => {
			execFile(process.execPath, [this.script, ...args], { env, timeout: 30_000 }, (error, stdout, stderr) => {
				if (error) {
					reject(new Error((stderr || stdout).trim().replace(/^korn: /, '') || error.message));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	async view(): Promise<BackgroundView> {
		const supported = process.platform === 'darwin' || process.platform === 'linux';
		const roots = await workspaceRepos();
		let overview: Overview | undefined;
		let error: string | undefined;
		try {
			overview = JSON.parse(await this.run(['status', '--json'])) as Overview;
			error = overview.configError;
		} catch (e) {
			error = (e as Error).message;
		}
		const repos = roots.map((root): BackgroundRepo => {
			const r = overview?.repos.find((x) => path.resolve(x.path) === root);
			return {
				root,
				name: path.basename(root),
				included: !!r,
				conflict: r?.conflict ?? 'keepBoth',
				frequency: r?.frequency ?? 'normal',
				lastSync: r?.lastSync,
				waiting: r?.waiting.length ?? 0,
				needsChoice: r?.needsChoice ?? [],
				notices: r?.notices ?? [],
				problem: r?.problem,
			};
		});
		return { supported, on: overview?.service ?? false, running: overview?.running ?? false, busy: this.busy, repos, error };
	}

	/** On: add this workspace's repos (if none are set up yet) and start the service · Off: stop it */
	async toggle(on: boolean, onChange: () => void): Promise<void> {
		this.busy = true;
		onChange();
		try {
			if (on) {
				const view = await this.view();
				if (!view.repos.some((r) => r.included)) {
					for (const repo of view.repos) {
						await this.run(['add', repo.root]);
					}
				}
				await this.run(['start']);
				vscode.window.showInformationMessage('Korn: เปิด sync เบื้องหลังแล้ว — ทำงานต่อแม้ปิด VS Code');
			} else {
				await this.run(['stop']);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Korn: ${(error as Error).message}`);
		} finally {
			this.busy = false;
			onChange();
		}
	}

	async set(root: string, options: { conflict?: ConflictPreset; frequency?: FrequencyPreset }) {
		const args = ['set', root];
		if (options.conflict) {
			args.push('--conflict', options.conflict);
		}
		if (options.frequency) {
			args.push('--frequency', options.frequency);
		}
		await this.run(args);
	}

	async include(root: string, included: boolean) {
		await this.run([included ? 'add' : 'remove', root]);
	}

	openLog() {
		const log = path.join(stateDir(), 'korn.log');
		if (existsSync(log)) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.file(log));
		} else {
			vscode.window.showInformationMessage('Korn: ยังไม่มี log ของ sync เบื้องหลัง');
		}
	}

	/** Like VS Code's "Install 'code' command in PATH": ~/.local/bin/korn → a stable copy of korn.js */
	async installCommand() {
		try {
			const share = path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'korn');
			mkdirSync(share, { recursive: true });
			const copy = path.join(share, 'korn.js');
			copyFileSync(this.script, copy);
			chmodSync(copy, 0o755);
			const bin = path.join(homedir(), '.local', 'bin');
			mkdirSync(bin, { recursive: true });
			const link = path.join(bin, 'korn');
			rmSync(link, { force: true });
			symlinkSync(copy, link);
			const inPath = (process.env.PATH ?? '').split(path.delimiter).includes(bin);
			vscode.window.showInformationMessage(
				inPath
					? 'Korn: ติดตั้งคำสั่ง korn แล้ว — เปิด terminal ใหม่แล้วพิมพ์ korn'
					: `Korn: ติดตั้ง korn ที่ ${link} แล้ว — เพิ่ม ~/.local/bin ใน PATH (export PATH="$HOME/.local/bin:$PATH") แล้วพิมพ์ korn`
			);
		} catch (error) {
			vscode.window.showErrorMessage(`Korn: ติดตั้งคำสั่งไม่ได้ — ${(error as Error).message}`);
		}
	}
}

/** Git repos of the workspace folders (a folder inside a repo counts as that repo) */
async function workspaceRepos(): Promise<string[]> {
	const roots = await Promise.all(
		(vscode.workspace.workspaceFolders ?? []).map((f) =>
			runGit(['rev-parse', '--show-toplevel'], f.uri.fsPath).then(
				(s) => path.resolve(s.trim()),
				() => undefined
			)
		)
	);
	return [...new Set(roots.filter((r): r is string => !!r))];
}
