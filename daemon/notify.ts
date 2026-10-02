import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { appendEvent, vscodeShowsRepo } from '../src/shared/daemonBridge';
import type { NotifySetting, OpenSetting } from './config';
import { BUTTON_LATER, BUTTON_PICK } from './messages';
import { openMode, openToChoose, openToView } from './opener';
import { log } from './state';

// Notifications of the daemon, without extra software.
// - conflict: shown in VS Code (by the extension, with a Resolve button) when a VS Code window has the
//   repo open, otherwise a macOS dialog with "Open in VS Code". Plain osascript banners can't open
//   anything (macOS shows them as Script Editor's, and clicking opens Script Editor).
// - error: a banner (terminal-notifier if installed, osascript otherwise; notify-send on Linux)

export type Channel = 'vscode' | 'dialog' | 'banner' | 'none';

export function chooseChannel(kind: 'conflict' | 'error', setting: NotifySetting, vscodeOpen: boolean): Channel {
	if (setting === 'off') {
		return 'none';
	}
	if (kind === 'error' || setting === 'banner') {
		return 'banner';
	}
	if (setting === 'dialog') {
		return 'dialog';
	}
	return vscodeOpen ? 'vscode' : 'dialog'; // auto
}

export interface Notifier {
	/** `button` opens `file` (in VS Code: Korn, which shows the Resolve tab while it has conflict markers) */
	conflict(repo: string, file: string, message: string, button?: string): void;
	error(title: string, message: string): void;
}

export function createNotifier(setting: NotifySetting, open: OpenSetting = 'auto'): Notifier {
	const effective: NotifySetting = process.env.KORN_NOTIFY === '0' ? 'off' : setting;
	const mode = openMode(open);
	return {
		conflict(repo, file, message, button = BUTTON_PICK) {
			const channel = chooseChannel('conflict', effective, mode === 'vscode' && vscodeShowsRepo(repo));
			if (channel === 'vscode') {
				appendEvent({ repo, file, message, button });
			} else if (channel === 'dialog') {
				dialog(file, message, button, () => (button === BUTTON_PICK ? openToChoose(mode, repo, file) : openToView(mode, file)));
			} else if (channel === 'banner') {
				banner('Korn: conflict', message, file);
			}
		},
		error(title, message) {
			if (chooseChannel('error', effective, false) === 'banner') {
				banner(title, message);
			}
		},
	};
}

// ---- Dialog: "<button>" / "ไว้ก่อน" ----

// AppleScript string literal (same escapes as JSON for quotes, backslashes and newlines)
const quote = (s: string) => JSON.stringify(s);

export function dialogScript(message: string, button = BUTTON_PICK): string {
	return `display dialog ${quote(message)} with title "Korn" buttons {${quote(BUTTON_LATER)}, ${quote(button)}} default button ${quote(button)} giving up after 60`;
}

/** osascript prints e.g. "button returned:เลือกเลย, gave up:false" */
export function parseDialogResult(stdout: string, button = BUTTON_PICK): 'open' | 'later' | 'timeout' {
	if (/gave up:true/.test(stdout)) {
		return 'timeout';
	}
	return stdout.includes(`button returned:${button}`) ? 'open' : 'later';
}

const openDialogs = new Set<string>(); // one dialog per file at a time

function dialog(file: string, message: string, button: string, onOpen: () => void) {
	if (process.platform !== 'darwin') {
		banner('Korn: conflict', message, file);
		return;
	}
	if (openDialogs.has(file)) {
		return;
	}
	openDialogs.add(file);
	// async: the daemon keeps running while the dialog waits for a click
	execFile('osascript', ['-e', dialogScript(message, button)], { timeout: 70_000 }, (error, stdout, stderr) => {
		openDialogs.delete(file);
		if (error) {
			if (!/-128/.test(stderr)) {
				// e.g. -1713 "No user interaction allowed" when macOS won't let a background job show it
				log(`notify: dialog failed (${stderr.trim() || error.message}), showing a banner instead`);
				banner('Korn: conflict', message, file);
			}
			return;
		}
		if (parseDialogResult(stdout, button) === 'open') {
			onOpen();
		}
	});
}

// ---- Banner ----

function terminalNotifier(): string | undefined {
	const dirs = [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
	return dirs.map((d) => path.join(d, 'terminal-notifier')).find((p) => existsSync(p));
}

function banner(title: string, message: string, file?: string) {
	const done = () => undefined;
	const notifier = process.platform === 'darwin' ? terminalNotifier() : undefined;
	if (notifier) {
		// optional: when installed, clicking the banner opens the file
		const args = ['-title', title, '-message', message, '-group', `korn:${file ?? title}`];
		if (file) {
			args.push('-open', `vscode://file${encodeURI(file)}`);
		}
		execFile(notifier, args, done);
	} else if (process.platform === 'darwin') {
		execFile('osascript', ['-e', `display notification ${quote(message)} with title ${quote(title)}`], done);
	} else if (process.platform === 'linux') {
		execFile('notify-send', [title, message], done);
	}
}
