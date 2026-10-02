import * as vscode from 'vscode';
import { registerBackgroundCommands } from './commands/background';
import { registerConflictCommands, notifyConflict } from './commands/conflict';
import { ensureRightEditor, registerEditorCommands } from './commands/editors';
import { registerFileCommands } from './commands/files';
import { registerShortcutCommands } from './commands/shortcuts';
import { registerSyncCommands, syncOne } from './commands/sync';
import { ctx } from './context';
import { Background } from './daemon/background';
import { ConflictStore } from './state/conflicts';
import { AutoSync } from './sync/autoSync';
import { watchBranches } from './sync/branchWatch';
import { watchDaemon } from './sync/daemonEvents';
import { RmdEditorProvider } from './views/editorProvider';
import { SyncViewProvider } from './views/panelProvider';

// Called once when the extension is activated: create the shared objects and wire everything up.
// The commands themselves live in src/commands/.
export function activate(context: vscode.ExtensionContext) {
	ctx.conflicts = new ConflictStore();
	ctx.state = context.globalState;
	ctx.background = new Background(context.extensionUri);
	ctx.panel = new SyncViewProvider(context.extensionUri, ctx.conflicts, () => ctx.autoSync.statusText(), ctx.background);
	ctx.autoSync = new AutoSync(
		ctx.conflicts,
		(uri) => syncOne(uri, { quiet: true }),
		() => ctx.panel.refresh(),
		(uri) => notifyConflict(uri)
	);
	const { conflicts, panel, autoSync } = ctx;

	// Look for new versions on the remote when the Korn panel is shown (at most once a minute)
	panel.onShow = () => autoSync.checkRemote();

	// Keep the file list in the side panel up to date
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.r.md');
	context.subscriptions.push(
		watcher,
		watcher.onDidCreate(() => panel.refresh()),
		watcher.onDidDelete(() => panel.refresh()),
		watcher.onDidChange(() => panel.refresh()),
		vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.path.endsWith('.r.md') && panel.refresh()),
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused) {
				panel.refresh();
				autoSync.checkRemote(); // back in VS Code: anything new on the remote?
			}
		})
	);

	context.subscriptions.push(
		conflicts,
		autoSync,
		vscode.window.registerWebviewViewProvider(SyncViewProvider.viewId, panel),
		vscode.window.registerCustomEditorProvider(RmdEditorProvider.viewType, new RmdEditorProvider(context.extensionUri, conflicts)),
		...registerSyncCommands(),
		...registerBackgroundCommands(),
		...registerConflictCommands(),
		...registerFileCommands(),
		...registerShortcutCommands(),
		...registerEditorCommands(),
		// conflicts found by the korn daemon (if installed) show here
		watchDaemon(() => panel.refreshBackground())
	);

	// Switching branch: forget conflicts of the old branch and show the new one in the side panel
	watchBranches(conflicts, () => panel.refresh()).then((watcher) => context.subscriptions.push(watcher));

	ensureRightEditor();
}

export function deactivate() {}
