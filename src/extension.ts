import * as vscode from 'vscode';
import { ConflictStore } from './conflicts';
import { ConflictAction, getMergeState, resolveConflict, SyncOutcome, syncFile } from './gitSync';
import { RmdEditorProvider } from './rmdEditorProvider';
import { SyncViewProvider } from './syncViewProvider';

// Called once when the extension is activated
const conflicts = new ConflictStore();

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		conflicts,
		vscode.window.registerWebviewViewProvider(
			SyncViewProvider.viewId,
			new SyncViewProvider(context.extensionUri, conflicts)
		),

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

			const name = vscode.workspace.asRelativePath(target);
			try {
				const result = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: `Sync ${name}…` },
					() => syncFile(target)
				);
				if (result.kind === 'conflict') {
					conflicts.add(target);
					askConflictAction(target); // not awaited: the Sync button finishes with state "conflict"
				} else {
					conflicts.remove(target);
					vscode.window.showInformationMessage(
						result.committed ? `Synced: ${result.message}` : `ไม่มีการเปลี่ยนแปลงใน ${name} — push แล้ว`
					);
				}
				return result;
			} catch (error) {
				showGitError(`Sync ${name} ไม่สำเร็จ`, error);
				throw error;
			}
		}),

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
	{ label: '$(git-merge) 3. Resolve conflict', detail: 'แก้เองใน Source Control', action: 'resolve' },
];

// Compact vertical list (Quick Pick) instead of a wide modal dialog
function askConflictAction(uri: vscode.Uri) {
	const name = vscode.workspace.asRelativePath(uri);
	const pick = vscode.window.createQuickPick<ConflictChoice>();
	pick.title = `⚠ Conflict: ${name} ถูกแก้บน remote ด้วย`;
	pick.placeholder = 'เลือกวิธีจัดการ (Esc = เลือกทีหลังในแผง Korn Sync)';
	pick.items = CONFLICT_CHOICES;
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
		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Resolve conflict ${name}…` },
			() => resolveConflict(uri, action, copyName)
		);

		if (action === 'resolve') {
			// VS Code's Text Editor shows the conflict with Accept Current / Incoming / Both
			await switchView(uri, 'default');
			await vscode.commands.executeCommand('workbench.view.scm');
			vscode.window.showInformationMessage(
				`แก้ conflict ใน ${name}: เลือก Accept Current / Incoming / Both แล้วกด Cmd+S จะกลับไปหน้า Korn ให้ จากนั้นกด Sync (ไม่ต้อง commit เอง)`
			);
			return;
		}

		conflicts.remove(uri);
		if (action === 'saveCopy' && copyName) {
			vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(uri, '..', copyName));
		}
		vscode.window.showInformationMessage(`Synced: ${result?.kind === 'synced' ? result.message ?? name : name}`);
	} catch (error) {
		showGitError(`แก้ conflict ${name} ไม่สำเร็จ`, error);
	}
}

function showGitError(title: string, error: unknown) {
	const detail = error instanceof Error ? error.message : String(error);
	vscode.window
		.showErrorMessage(`${title}: ${detail}`, 'Open Source Control')
		.then((choice) => choice && vscode.commands.executeCommand('workbench.view.scm'));
}

let switching = false;

// The active .r.md tab should be in the Korn editor, except while it still has conflict markers:
// then VS Code's Text Editor is used (Accept Current / Incoming / Both). Diff and merge editors are left alone.
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
		const desired = (await getMergeState(input.uri)) === 'unresolved' ? 'default' : RmdEditorProvider.viewType;
		if (current !== desired) {
			await switchView(input.uri, desired);
		}
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
