import { realpathSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConflictStore } from '../state/conflicts';
import * as ops from '../git/ops';
import type { FileRow, FileRowState } from '../shared/protocol';
export type { FileRow, FileRowState };

// Sort order in the side panel: what needs attention first
const ORDER: Record<FileRowState, number> = {
	conflict: 0,
	blocked: 1,
	dirty: 2,
	ahead: 3,
	incoming: 4,
	synced: 5,
	never: 6,
	nogit: 7,
};

function safeRealpath(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		return file;
	}
}

async function repoRoot(folder: string): Promise<string | undefined> {
	try {
		return (await ops.runGit(['rev-parse', '--show-toplevel'], folder)).trim();
	} catch {
		return undefined;
	}
}

/** Every .r.md in the workspace with its sync state (git is asked once per repo). */
export async function listRmdFiles(conflicts: ConflictStore): Promise<FileRow[]> {
	const uris = await vscode.workspace.findFiles('**/*.r.md', '**/node_modules/**');

	// Group files by repo root (a workspace can hold several repos)
	const roots = new Map<string, string | undefined>(); // folder -> repo root
	const byRepo = new Map<string, vscode.Uri[]>();
	const noRepo: vscode.Uri[] = [];
	for (const uri of uris) {
		const folder = path.dirname(uri.fsPath);
		if (!roots.has(folder)) {
			roots.set(folder, await repoRoot(folder));
		}
		const root = roots.get(folder);
		if (root) {
			byRepo.set(root, [...(byRepo.get(root) ?? []), uri]);
		} else {
			noRepo.push(uri);
		}
	}

	const rows: FileRow[] = [];
	const row = (uri: vscode.Uri, state: FileRowState, root?: string, status?: ops.FileStatus): FileRow => {
		const incoming = !!status?.incoming;
		let shown = state;
		if (conflicts.has(uri)) {
			shown = 'conflict';
		} else if (incoming && (state === 'synced' || state === 'never')) {
			shown = 'incoming'; // nothing of ours to send, just something new to get
		}
		return {
			uri: uri.toString(),
			name: vscode.workspace.asRelativePath(uri),
			root,
			state: shown,
			lastSync: status?.lastSync,
			incoming,
			unsaved: vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === uri.toString()),
			busy: conflicts.isBusy(uri),
		};
	};

	for (const [root, files] of byRepo) {
		const states = await ops.repoFileStates(root).catch(() => new Map<string, ops.FileStatus>());
		const repoRows: FileRow[] = [];
		for (const uri of files) {
			// realpath: git prints the resolved root (e.g. /private/tmp for /tmp on macOS)
			const rel = path.relative(root, safeRealpath(uri.fsPath)).split(path.sep).join('/');
			const status = states.get(rel);
			repoRows.push(row(uri, status?.state ?? 'never', root, status));
		}

		// A conflict (or an unfinished "Resolve in Korn" merge) holds back every unpushed commit of the repo
		const conflicted = repoRows.find((r) => r.state === 'conflict');
		const blockedBy = conflicted?.name ?? ((await ops.operationInProgress(root).catch(() => false)) ? 'merge ที่ค้างอยู่' : undefined);
		for (const r of repoRows) {
			if (blockedBy && r.state === 'ahead') {
				r.state = 'blocked';
				r.blockedBy = blockedBy;
			}
		}
		rows.push(...repoRows);
	}
	for (const uri of noRepo) {
		rows.push(row(uri, 'nogit'));
	}

	return rows.sort(
		(a, b) =>
			ORDER[a.state] - ORDER[b.state] ||
			(b.lastSync ?? '').localeCompare(a.lastSync ?? '') ||
			a.name.localeCompare(b.name)
	);
}
