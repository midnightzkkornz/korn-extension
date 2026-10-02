import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import type { OpenSetting } from './config';
import { stateDir } from './config';

// Where a conflict opens when someone clicks "เลือกเลย" / "เปิดดู":
// - vscode:   the file in VS Code (Korn shows the Resolve tab)
// - terminal: a Terminal window running `korn resolve <file>` · "เปิดดู" opens the file with its default app

export type OpenMode = 'vscode' | 'terminal';

export function hasVSCode(): boolean {
	const apps = ['/Applications', path.join(homedir(), 'Applications')].map((d) => path.join(d, 'Visual Studio Code.app'));
	const inPath = (process.env.PATH ?? '').split(path.delimiter).some((d) => d && existsSync(path.join(d, 'code')));
	return apps.some((a) => existsSync(a)) || inPath;
}

export function openMode(setting: OpenSetting, vscodeInstalled = hasVSCode()): OpenMode {
	return setting === 'auto' ? (vscodeInstalled ? 'vscode' : 'terminal') : setting;
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A .command file: double-clicked or `open`ed, macOS runs it in Terminal (no Automation permission needed) */
export function resolveCommandScript(repo: string, file: string, runtime: string, script: string): string {
	return `#!/bin/bash
# korn: pick per conflict, then this window can be closed
cd ${sh(repo)} || exit 1
ELECTRON_RUN_AS_NODE=1 ${sh(runtime)} ${sh(script)} resolve ${sh(file)}
echo
read -n 1 -s -r -p "กดปุ่มใดก็ได้เพื่อปิด"
`;
}

const done = () => undefined;

/** "เลือกเลย": open the place to pick per conflict */
export function openToChoose(mode: OpenMode, repo: string, file: string) {
	if (mode === 'vscode') {
		openInVSCode(file);
		return;
	}
	const command = path.join(stateDir(), 'resolve.command');
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(command, resolveCommandScript(repo, path.relative(repo, file), process.execPath, path.resolve(process.argv[1])));
	chmodSync(command, 0o755);
	execFile('open', [command], done);
}

/** "เปิดดู": show the file */
export function openToView(mode: OpenMode, file: string) {
	if (mode === 'vscode') {
		openInVSCode(file);
	} else {
		execFile('open', [file], done);
	}
}

// vscode://file/… opens it in VS Code (a .r.md opens in Korn); without VS Code, the default app
function openInVSCode(file: string) {
	execFile('open', [`vscode://file${encodeURI(file)}`], (error) => {
		if (error) {
			execFile('open', [file], done);
		}
	});
}
