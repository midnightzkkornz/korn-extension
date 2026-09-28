import * as vscode from 'vscode';
import { AutoSync, describeSettings } from './autoSync';
import { ConflictStore } from './conflicts';
import { listRmdFiles } from './fileStatus';
import { ConflictAction, getMergeState, resolveConflict, SyncOutcome, syncFile } from './gitSync';
import { RmdEditorProvider } from './rmdEditorProvider';
import { SyncViewProvider } from './syncViewProvider';

const conflicts = new ConflictStore();
let panel: SyncViewProvider;
let autoSync: AutoSync;

// Called once when the extension is activated
export function activate(context: vscode.ExtensionContext) {
	panel = new SyncViewProvider(context.extensionUri, conflicts, () => describeSettings(autoSync.currentSettings));
	autoSync = new AutoSync(conflicts, (uri) => syncOne(uri, { quiet: true }), () => panel.refresh());

	// Keep the file list in the side panel up to date
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.r.md');
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(() => panel.refresh()),
		watcher.onDidDelete(() => panel.refresh()),
		watcher.onDidChange(() => panel.refresh()),
		vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.path.endsWith('.r.md') && panel.refresh()),
		vscode.window.onDidChangeWindowState((state) => state.focused && panel.refresh())
	);

	context.subscriptions.push(
		conflicts,
		autoSync,
		vscode.window.registerWebviewViewProvider(SyncViewProvider.viewId, panel),

		vscode.window.registerCustomEditorProvider(
			RmdEditorProvider.viewType,
			new RmdEditorProvider(context.extensionUri, conflicts)
		),

		// Sync button (Korn toolbar, editor title bar, side panel): add + commit + push this file
		vscode.commands.registerCommand('korn.sync', async (uri?: vscode.Uri): Promise<SyncOutcome | undefined> => {
			const target = activeUri(uri);
			if (!target || !target.path.endsWith('.r.md')) {
				vscode.window.showWarningMessage('เปิดไฟล์ .r.md ก่อนกด Sync');
				return undefined;
			}

			return syncOne(target);
		}),

		// Sync every .r.md that has unsynced changes (side panel "Sync all")
		vscode.commands.registerCommand('korn.syncAll', () => syncAll()),

		// Show the conflict choices again (clicking "Conflict — เลือกวิธีจัดการ" in the Korn toolbar)
		vscode.commands.registerCommand('korn.showConflictChoices', (uri: vscode.Uri) => askConflictAction(uri)),

		// The 3 conflict choices (modal dialog + side panel)
		vscode.commands.registerCommand('korn.resolveConflict', (uri: vscode.Uri | string, action: ConflictAction) =>
			handleConflict(typeof uri === 'string' ? vscode.Uri.parse(uri) : uri, action)
		),

		vscode.commands.registerCommand('korn.newFile', async () => {
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (!folder) {
				vscode.window.showWarningMessage('เปิดโฟลเดอร์ก่อนสร้างไฟล์ .r.md');
				return;
			}

			const name = await vscode.window.showInputBox({
				prompt: 'ชื่อไฟล์ (ไม่ต้องใส่ .r.md)',
				placeHolder: 'notes',
				validateInput: (value) => (value.trim() ? undefined : 'กรุณาใส่ชื่อไฟล์'),
			});
			if (!name) {
				return;
			}

			const fileUri = vscode.Uri.joinPath(folder.uri, `${name.trim()}.r.md`);
			try {
				await vscode.workspace.fs.stat(fileUri);
				vscode.window.showWarningMessage(`มีไฟล์ ${name.trim()}.r.md อยู่แล้ว`);
			} catch {
				await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(`# ${name.trim()}\n\n`));
			}
			// vscode.open respects the default custom editor for *.r.md
			await vscode.commands.executeCommand('vscode.open', fileUri);
		}),

		// .r.md files always show in the Korn editor (VS Code's Text Editor only while fixing a conflict)
		vscode.window.tabGroups.onDidChangeTabs(() => ensureRightEditor()),
		// After Accept … + Cmd+S the markers are gone: go back to the Korn editor
		vscode.workspace.onDidSaveTextDocument((d) => d.uri.path.endsWith('.r.md') && ensureRightEditor()),

		// "Open in VS Code editor" from the Resolve mode (VS Code's Accept Current / Incoming / Both)
		vscode.commands.registerCommand('korn.openTextEditor', (uri: vscode.Uri) => switchView(uri, 'default')),

		// Back to the Korn editor from any other editor (editor title bar)
		vscode.commands.registerCommand('korn.openKorn', (uri?: vscode.Uri) => switchView(uri, RmdEditorProvider.viewType))
	);

	ensureRightEditor();
}

export function deactivate() {}

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

/**
 * Sync one file. Used by the Sync buttons (quiet = false) and by auto-sync / Sync all (quiet = true):
 * quiet = no popups on success, and a conflict gives one notification instead of opening the choices.
 */
async function syncOne(target: vscode.Uri, { quiet = false } = {}): Promise<SyncOutcome | undefined> {
	const name = vscode.workspace.asRelativePath(target);
	try {
		const run = await conflicts.runExclusive(target, () =>
			quiet
				? syncFile(target)
				: vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sync ${name}…` }, () =>
						syncFile(target)
					)
		);
		if (!run) {
			if (!quiet) {
				showBusy(name);
			}
			return undefined;
		}
		const result = run.value;
		if (result.kind === 'conflict') {
			conflicts.add(target);
			if (quiet) {
				vscode.window
					.showWarningMessage(`Conflict ใน ${name} — ไฟล์นี้ถูกแก้บน remote ด้วย`, 'เลือกวิธีจัดการ')
					.then((choice) => choice && askConflictAction(target));
			} else {
				askConflictAction(target); // not awaited: the Sync button finishes with state "conflict"
			}
		} else if (result.kind === 'synced') {
			conflicts.remove(target);
			if (quiet) {
				vscode.window.setStatusBarMessage(`$(check) Korn: synced ${name}`, 3000);
			} else {
				vscode.window.showInformationMessage(
					result.committed ? `Synced: ${result.message}` : `ไม่มีการเปลี่ยนแปลงใน ${name} — push แล้ว`
				);
			}
		}
		return result;
	} catch (error) {
		if (!quiet) {
			showGitError(`Sync ${name} ไม่สำเร็จ`, error);
		}
		throw error;
	} finally {
		panel.refresh();
	}
}

async function syncAll() {
	const rows = (await listRmdFiles(conflicts)).filter((row) => row.state === 'dirty' || row.state === 'ahead');
	if (rows.length === 0) {
		vscode.window.showInformationMessage('ทุกไฟล์ sync แล้ว');
		return;
	}
	let synced = 0;
	const failed: string[] = [];
	await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Sync all' }, async (progress) => {
		for (const [i, row] of rows.entries()) {
			progress.report({ message: `${row.name} (${i + 1}/${rows.length})`, increment: 100 / rows.length });
			try {
				const result = await syncOne(vscode.Uri.parse(row.uri), { quiet: true });
				if (result?.kind === 'synced') {
					synced++;
				}
			} catch (error) {
				failed.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});
	const summary = `Sync all: สำเร็จ ${synced}/${rows.length} ไฟล์`;
	if (failed.length) {
		vscode.window.showWarningMessage(`${summary} — ไม่สำเร็จ: ${failed.join(' · ')}`);
	} else {
		vscode.window.showInformationMessage(summary);
	}
}

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

function showBusy(name: string) {
	vscode.window.showInformationMessage(`กำลังจัดการ ${name} อยู่ รอสักครู่`);
}

// Compact vertical list (Quick Pick) instead of a wide modal dialog.
// While "Resolve in Korn" is in progress, option 3 continues it and a Cancel option is added.
async function askConflictAction(uri: vscode.Uri) {
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

async function handleConflict(uri: vscode.Uri, action: ConflictAction) {
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
		const base = uri.path.split('/').pop()!.replace(/\.r\.md$/, '');
		const folder = vscode.Uri.joinPath(uri, '..');
		copyName = await vscode.window.showInputBox({
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
		if (!copyName) {
			return; // cancelled, conflict stays in the side panel
		}
		copyName = copyName.trim();
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

function showGitError(title: string, error: unknown) {
	const detail = error instanceof Error ? error.message : String(error);
	vscode.window
		.showErrorMessage(`${title}: ${detail}`, 'Open Source Control')
		.then((choice) => choice && vscode.commands.executeCommand('workbench.view.scm'));
}

let switching = false;

// The active .r.md tab should be in the Korn editor (its Resolve mode handles conflicts).
// Exception: while the file still has conflict markers, VS Code's Text Editor may stay open if the user
// chose "Open in VS Code editor". Diff and merge editors are left alone.
async function ensureRightEditor() {
	if (switching) {
		return;
	}
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (!(input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) || !input.uri.path.endsWith('.r.md')) {
		return;
	}
	const current = input instanceof vscode.TabInputCustom ? input.viewType : 'default';

	switching = true;
	try {
		if (current === RmdEditorProvider.viewType) {
			return;
		}
		if (current === 'default' && (await getMergeState(input.uri)) === 'unresolved') {
			return;
		}
		await switchView(input.uri, RmdEditorProvider.viewType);
	} finally {
		switching = false;
	}
}

function activeUri(uri?: vscode.Uri): vscode.Uri | undefined {
	if (uri) {
		return uri;
	}
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	return undefined;
}

// Reopen the file with another editor in the same tab, like "Reopen Editor With..."
async function switchView(uri: vscode.Uri | undefined, viewType: string) {
	const target = activeUri(uri);
	if (!target) {
		return;
	}

	const group = vscode.window.tabGroups.activeTabGroup;
	const oldTab = group.activeTab;
	const oldInput = oldTab?.input;
	const oldView =
		oldInput instanceof vscode.TabInputCustom ? oldInput.viewType : oldInput instanceof vscode.TabInputText ? 'default' : undefined;
	const sameFile =
		(oldInput instanceof vscode.TabInputText || oldInput instanceof vscode.TabInputCustom) &&
		oldInput.uri.toString() === target.toString();

	if (sameFile && oldView === viewType) {
		return; // already in this view
	}

	await vscode.commands.executeCommand('vscode.openWith', target, viewType, group.viewColumn);

	if (oldTab && sameFile) {
		await vscode.window.tabGroups.close(oldTab, true);
	}
}
