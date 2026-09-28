import type { ConflictAction, FileRow, RepoInfo } from '../../src/shared/protocol';

// Text shown in the side panel (no DOM here, so it's easy to read and test)

export function formatTime(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function stateLabel(file: FileRow): string {
	if (file.busy) {
		return 'Syncing…';
	}
	switch (file.state) {
		case 'conflict':
			return 'conflict';
		case 'dirty':
			return 'แก้แล้ว ยังไม่ sync';
		case 'ahead':
			return 'commit แล้ว รอ push';
		case 'blocked':
			return `รอ push — ติด conflict ของ ${file.blockedBy}`;
		case 'incoming':
			return file.unsaved ? 'มีของใหม่ — เซฟแล้วจะรวมให้' : 'มีเวอร์ชันใหม่บน remote';
		case 'synced':
			return file.lastSync ? formatTime(file.lastSync) : 'sync แล้ว';
		case 'nogit':
			return 'ไม่ได้อยู่ใน git repo';
		case 'never':
			return 'ยังไม่เคย sync';
	}
}

// Tooltip of the row's ⟳ button (and of its status text)
export function syncTitle(file: FileRow): string {
	switch (file.state) {
		case 'blocked':
			return `จะ push ให้เองหลังแก้ conflict ของ ${file.blockedBy}`;
		case 'incoming':
			return 'ดึงเวอร์ชันใหม่มาจาก remote';
		case 'ahead':
			return 'กดเพื่อ push อีกครั้ง';
		default:
			return `Sync ${file.name}`;
	}
}

// blocked: pushing can't work until the conflict is handled · detached: no branch to sync to
export function canSync(file: FileRow, detached = false): boolean {
	return !detached && !file.busy && file.state !== 'nogit' && file.state !== 'blocked';
}

// Files "Sync all" handles: ours to send (dirty / ahead) and others' to get (incoming)
export function isPending(file: FileRow): boolean {
	return !file.busy && (file.state === 'dirty' || file.state === 'ahead' || file.state === 'incoming');
}

// Our own changes and a newer remote version at the same time: say both
export function showsIncomingNote(file: FileRow): boolean {
	return file.incoming && file.state !== 'incoming' && file.state !== 'conflict' && !file.busy;
}

export const CONFLICT_ACTIONS: [ConflictAction, string, boolean][] = [
	['keepMine', '1. Replace with my version', true],
	['saveCopy', '2. Save my work as copy…', false],
	['resolve', '3. Resolve in Korn', false],
];

// While "Resolve in Korn" is in progress: continue it, switch to 1/2, or cancel
export const RESOLVING_ACTIONS: [ConflictAction, string, boolean][] = [
	['resolve', '3. Continue in Resolve', true],
	['keepMine', '1. Replace with my version', false],
	['saveCopy', '2. Save my work as copy…', false],
	['cancel', 'Cancel resolve — เลือกวิธีอื่น', false],
];

// "⎇ feature/x → origin/feature/x" line above the file list; kind picks the color
export function repoLine(repo: RepoInfo): { text: string; kind: 'ok' | 'warn' | 'error' } {
	if (repo.detached) {
		return { text: `⎇ detached HEAD — Sync ไม่ได้ (checkout branch ก่อน)`, kind: 'error' };
	}
	if (!repo.upstream) {
		return { text: `⎇ ${repo.branch} · ยังไม่มีบน remote — Sync ครั้งแรกจะสร้างให้`, kind: 'warn' };
	}
	return { text: `⎇ ${repo.branch} → ${repo.upstream}`, kind: 'ok' };
}
