import * as vscode from 'vscode';
import { ctx } from '../context';
import { ConflictAction, getMergeState, resolveConflict } from '../git/sync';
import { showBusy, showGitError } from '../shared/ui';
import { RmdEditorProvider } from '../views/editorProvider';
import { SyncViewProvider } from '../views/panelProvider';
import { switchView } from './editors';

// What to do when Sync hits a conflict: 1. keep mine · 2. save mine as copy · 3. resolve in Korn

interface ConflictChoice extends vscode.QuickPickItem {
	action: ConflictAction;
}

const CONFLICT_CHOICES: ConflictChoice[] = [
	{ label: '$(check) 1. Replace with my version', detail: 'ใช้เนื้อหาของเรา แล้ว commit & push', action: 'keepMine' },
	{
		label: '$(files) 2. Save my work as copy…',
		detail: 'ไฟล์นี้ใช้เวอร์ชันบน remote ส่วนงานของเราเก็บเป็นไฟล์ใหม่ แล้ว commit & push',
		action: 'saveCopy',
	},
	{
		label: '$(git-merge) 3. Resolve in Korn',
		detail: 'เลือกทีละจุด: ของเรา / ของอีกคน / ทั้งคู่ / แก้เอง แล้วกด Finish & Sync',
		action: 'resolve',
	},
];

const CONTINUE_RESOLVE: ConflictChoice = {
	label: '$(git-merge) 3. Continue in Resolve',
	detail: 'กลับไปแท็บ ⚠ Resolve ที่เลือกค้างไว้',
	action: 'resolve',
};
const CANCEL_RESOLVE: ConflictChoice = {
	label: '$(discard) Cancel resolve — เลือกวิธีอื่น',
	detail: 'ยกเลิกสิ่งที่แก้ในแท็บ Resolve แล้วกลับไปเลือกใหม่',
	action: 'cancel',
};

const ACTION_NAMES: Record<ConflictAction, string> = {
	keepMine: 'Replace with my version',
	saveCopy: 'Save my work as copy',
	resolve: 'Resolve in Korn',
	cancel: 'Cancel resolve',
};

// Background conflicts (auto-sync, Sync all): one notification instead of opening the choices
export function notifyConflict(uri: vscode.Uri) {
	vscode.window
		.showWarningMessage(`Conflict ใน ${vscode.workspace.asRelativePath(uri)} — ไฟล์นี้ถูกแก้บน remote ด้วย`, 'เลือกวิธีจัดการ')
		.then((choice) => choice && askConflictAction(uri));
}

// Compact vertical list (Quick Pick) instead of a wide modal dialog.
// While "Resolve in Korn" is in progress, option 3 continues it and a Cancel option is added.
export async function askConflictAction(uri: vscode.Uri) {
	const name = vscode.workspace.asRelativePath(uri);
	const state = await getMergeState(uri);
	const resolving = state === 'unresolved' || state === 'resolved';

	const pick = vscode.window.createQuickPick<ConflictChoice>();
	pick.title = `⚠ Conflict: ${name} ถูกแก้บน remote ด้วย`;
	pick.placeholder = resolving
		? 'กำลังแก้ในแท็บ Resolve อยู่ — ทำต่อ หรือเปลี่ยนวิธี (Esc = ปิด)'
		: 'เลือกวิธีจัดการ (Esc = เลือกทีหลังในแผง Korn Sync)';
	pick.items = resolving ? [CONTINUE_RESOLVE, CONFLICT_CHOICES[0], CONFLICT_CHOICES[1], CANCEL_RESOLVE] : CONFLICT_CHOICES;
	pick.ignoreFocusOut = true;

	let chosen: ConflictAction | undefined;
	pick.onDidAccept(() => {
		chosen = pick.selectedItems[0]?.action;
		pick.hide();
	});
	pick.onDidHide(() => {
		pick.dispose();
		if (chosen) {
			handleConflict(uri, chosen);
		} else {
			vscode.commands.executeCommand(`${SyncViewProvider.viewId}.focus`);
		}
	});
	pick.show();
}

async function askCopyName(uri: vscode.Uri): Promise<string | undefined> {
	const base = uri.path.split('/').pop()!.replace(/\.r\.md$/, '');
	const folder = vscode.Uri.joinPath(uri, '..');
	const copyName = await vscode.window.showInputBox({
		prompt: 'ตั้งชื่อไฟล์ใหม่สำหรับเก็บงานของเรา',
		value: `${base}-copy.r.md`,
		valueSelection: [0, base.length + 5],
		validateInput: async (value) => {
			if (!value.trim().endsWith('.r.md')) {
				return 'ชื่อไฟล์ต้องลงท้ายด้วย .r.md';
			}
			try {
				await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, value.trim()));
				return 'มีไฟล์ชื่อนี้อยู่แล้ว';
			} catch {
				return undefined;
			}
		},
	});
	return copyName?.trim();
}

export async function handleConflict(uri: vscode.Uri, action: ConflictAction) {
	const { conflicts, panel } = ctx;
	const name = vscode.workspace.asRelativePath(uri);
	if (conflicts.isBusy(uri)) {
		showBusy(name);
		return;
	}

	// Switching away from "Resolve in Korn" throws away what was fixed there: ask first
	const state = await getMergeState(uri);
	const resolving = state === 'unresolved' || state === 'resolved';
	if (resolving && (action === 'keepMine' || action === 'saveCopy' || action === 'cancel')) {
		const confirm = action === 'cancel' ? 'ยกเลิกแล้วเลือกใหม่' : `ยกเลิกแล้วใช้ "${ACTION_NAMES[action]}"`;
		const answer = await vscode.window.showWarningMessage(
			`ยกเลิกสิ่งที่แก้ในแท็บ Resolve ของ ${name}?`,
			{ modal: true, detail: 'ไฟล์จะกลับเป็นเวอร์ชันของเราก่อนเริ่ม Resolve ส่วนไฟล์อื่นที่แก้ค้างไว้ไม่หาย' },
			confirm
		);
		if (answer !== confirm) {
			return; // keep resolving
		}
	}

	let copyName: string | undefined;
	if (action === 'saveCopy') {
		copyName = await askCopyName(uri);
		if (!copyName) {
			return; // cancelled, conflict stays in the side panel
		}
	}

	try {
		const run = await conflicts.runExclusive(uri, () =>
			vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `${ACTION_NAMES[action]}: ${name}…` },
				() => resolveConflict(uri, action, copyName)
			)
		);
		if (!run) {
			showBusy(name);
			return;
		}
		const result = run.value;

		if (result?.kind === 'noConflict') {
			conflicts.remove(uri);
			vscode.window.showInformationMessage(`ไม่มี conflict ใน ${name} แล้ว — กด Sync ได้ตามปกติ`);
			return;
		}

		if (action === 'cancel') {
			conflicts.add(uri, false);
			askConflictAction(uri); // choose again
			return;
		}

		if (action === 'resolve') {
			conflicts.add(uri, true);
			// The Korn editor switches to its Resolve mode by itself when it sees the conflict markers
			await switchView(uri, RmdEditorProvider.viewType);
			vscode.window.showInformationMessage(`แก้ conflict ใน ${name} ในแท็บ ⚠ Resolve แล้วกด Finish & Sync`);
			return;
		}

		conflicts.remove(uri);
		if (action === 'saveCopy' && copyName) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(uri, '..', copyName));
		}
		vscode.window.showInformationMessage(`Synced: ${result?.kind === 'synced' ? result.message ?? name : name}`);
	} catch (error) {
		showGitError(`${ACTION_NAMES[action]} ${name} ไม่สำเร็จ`, error);
	} finally {
		panel.refresh();
	}
}

export function registerConflictCommands(): vscode.Disposable[] {
	return [
		// Show the conflict choices again (clicking "Conflict — เลือกวิธีจัดการ" in the Korn toolbar)
		vscode.commands.registerCommand('korn.showConflictChoices', (uri: vscode.Uri) => askConflictAction(uri)),

		// The 3 conflict choices (Quick Pick + side panel)
		vscode.commands.registerCommand('korn.resolveConflict', (uri: vscode.Uri | string, action: ConflictAction) =>
			handleConflict(typeof uri === 'string' ? vscode.Uri.parse(uri) : uri, action)
		),
	];
}
