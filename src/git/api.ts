import * as vscode from 'vscode';

// VS Code's built-in Git extension: used for fetch/push so they go through the same
// login/credentials as VS Code. Minimal typings of extensions/git/src/api/git.d.ts.

export interface Branch {
	readonly name?: string;
	readonly upstream?: { readonly remote: string; readonly name: string };
}

export interface Repository {
	readonly rootUri: vscode.Uri;
	readonly state: { readonly HEAD: Branch | undefined };
	fetch(): Promise<void>;
	push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
	status(): Promise<void>;
}

export interface GitAPI {
	getRepository(uri: vscode.Uri): Repository | null;
}

export async function getGitApi(): Promise<GitAPI> {
	const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
	if (!ext) {
		throw new Error('ไม่พบ Git extension ของ VS Code');
	}
	const exports = ext.isActive ? ext.exports : await ext.activate();
	return exports.getAPI(1);
}

// Push the current branch (sets the upstream the first time)
export async function push(repo: Repository) {
	await repo.status(); // pick up commits made with the git CLI
	const head = repo.state.HEAD;
	if (head?.upstream) {
		await repo.push();
	} else {
		await repo.push('origin', head?.name, true);
	}
	await repo.status();
}
