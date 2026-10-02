import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import { stateDir } from './config';

// `korn start` / `korn stop`: run the daemon in the background at login, without brew services.
// macOS: a LaunchAgent · Linux: a systemd user unit.
// korn.js is copied to ~/.local/share/korn/ first, so the service doesn't depend on where it was
// started from (the VS Code extension's folder changes with every version).

export const LABEL = 'com.midnightzkkornz.korn';
const PATH_ENV = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function installDir(): string {
	return process.env.KORN_INSTALL_DIR ?? path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'korn');
}

// KORN_SERVICE_DIR overrides where the plist / unit goes (tests)
function plistPath(): string {
	return path.join(process.env.KORN_SERVICE_DIR ?? path.join(homedir(), 'Library', 'LaunchAgents'), `${LABEL}.plist`);
}

function unitPath(): string {
	const dir = process.env.KORN_SERVICE_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'systemd', 'user');
	return path.join(dir, 'korn.service');
}

/** The program that runs korn.js: node from PATH, else the runtime running us (e.g. VS Code's) */
export function nodeCommand(): { program: string; env: Record<string, string> } {
	for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...PATH_ENV.split(':')]) {
		const candidate = path.join(dir, 'node');
		if (dir && existsSync(candidate)) {
			return { program: candidate, env: {} };
		}
	}
	// Electron (VS Code) runs scripts like node with this variable
	return { program: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchAgentPlist(program: string, script: string, env: Record<string, string>, logFile: string): string {
	const vars = { PATH: PATH_ENV, ...env };
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(program)}</string>
		<string>${xml(script)}</string>
		<string>daemon</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(vars)
	.map(([k, v]) => `		<key>${xml(k)}</key>\n		<string>${xml(v)}</string>`)
	.join('\n')}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>${xml(logFile)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(program: string, script: string, env: Record<string, string>): string {
	const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
	return `[Unit]
Description=korn — sync markdown notes through git

[Service]
ExecStart=${quote(program)} ${quote(script)} daemon
Restart=always
RestartSec=10
${Object.entries({ PATH: PATH_ENV, ...env })
	.map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
	.join('\n')}

[Install]
WantedBy=default.target
`;
}

// KORN_SERVICE_DRYRUN=1: write the files but don't call launchctl/systemctl (tests)
function run(program: string, args: string[], ignoreError = false) {
	if (process.env.KORN_SERVICE_DRYRUN === '1') {
		return;
	}
	try {
		execFileSync(program, args, { stdio: 'pipe' });
	} catch (error) {
		if (!ignoreError) {
			const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
			throw new Error(`${program} ${args.join(' ')}: ${stderr || (error as Error).message}`);
		}
	}
}

/** Install (or refresh) the service from the korn.js at `script` and start it */
export function startService(script: string): string {
	const target = path.join(installDir(), 'korn.js');
	mkdirSync(installDir(), { recursive: true });
	if (path.resolve(script) !== path.resolve(target)) {
		copyFileSync(script, target);
	}
	const { program, env } = nodeCommand();

	if (process.platform === 'darwin') {
		const uid = process.getuid?.() ?? 0;
		mkdirSync(path.dirname(plistPath()), { recursive: true });
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(plistPath(), launchAgentPlist(program, target, env, path.join(stateDir(), 'daemon.out.log')));
		run('launchctl', ['bootout', `gui/${uid}/${LABEL}`], true); // restart with the new copy if it was running
		run('launchctl', ['bootstrap', `gui/${uid}`, plistPath()]);
		return plistPath();
	}
	if (process.platform === 'linux') {
		mkdirSync(path.dirname(unitPath()), { recursive: true });
		writeFileSync(unitPath(), systemdUnit(program, target, env));
		run('systemctl', ['--user', 'daemon-reload']);
		run('systemctl', ['--user', 'enable', 'korn.service']);
		run('systemctl', ['--user', 'restart', 'korn.service']);
		return unitPath();
	}
	throw new Error('korn start ใช้ได้บน macOS และ Linux — บน Windows ใช้ korn daemon ใน terminal');
}

export function stopService(): boolean {
	if (process.platform === 'darwin') {
		const existed = existsSync(plistPath());
		run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${LABEL}`], true);
		rmSync(plistPath(), { force: true });
		return existed;
	}
	if (process.platform === 'linux') {
		const existed = existsSync(unitPath());
		run('systemctl', ['--user', 'disable', '--now', 'korn.service'], true);
		rmSync(unitPath(), { force: true });
		run('systemctl', ['--user', 'daemon-reload'], true);
		return existed;
	}
	return false;
}

/** Is the background service set up (it starts again at login)? */
export function serviceInstalled(): boolean {
	return process.platform === 'darwin' ? existsSync(plistPath()) : process.platform === 'linux' ? existsSync(unitPath()) : false;
}
