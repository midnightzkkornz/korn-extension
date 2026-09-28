import * as path from 'path';
import * as vscode from 'vscode';
import { getGitApi, Repository } from '../git/api';
import * as ops from '../git/ops';
import { log } from '../shared/log';
import type { ConflictStore } from '../state/conflicts';

/**
 * Notices when a repo switches branch (checkout in VS Code or a terminal): conflicts remembered
 * for the old branch no longer apply, so they're cleared and the side panel refreshes.
 */
export async function watchBranches(conflicts: ConflictStore, onChange: () => void): Promise<vscode.Disposable> {
	const disposables: vscode.Disposable[] = [];
	let api;
	try {
		api = await getGitApi();
	} catch {
		return new vscode.Disposable(() => {}); // no Git extension: nothing to watch
	}

	const watch = (repo: Repository) => {
		const root = repo.rootUri.fsPath;
		let last = repo.state.HEAD?.name; // undefined = detached
		disposables.push(
			repo.state.onDidChange(async () => {
				const current = repo.state.HEAD?.name;
				if (current === last) {
					return;
				}
				log(`branch ${path.basename(root)}: ${last ?? 'detached'} → ${current ?? 'detached'}`);
				last = current;
				// git doesn't let you switch branch in the middle of a merge, but be safe
				if (!(await ops.operationInProgress(root).catch(() => false))) {
					conflicts.clearRepo(root);
				}
				onChange();
			})
		);
	};

	api.repositories.forEach(watch);
	disposables.push(api.onDidOpenRepository(watch));
	return new vscode.Disposable(() => disposables.forEach((d) => d.dispose()));
}
