import * as path from 'path';

// The sentences people see about conflicts, in one place: notifications, VS Code, `korn`, the log.

export const BUTTON_PICK = 'เลือกเลย';
export const BUTTON_VIEW = 'เปิดดู';
export const BUTTON_LATER = 'ไว้ก่อน';

const name = (file: string) => path.posix.basename(file);

export const conflictMessage = {
	/** policy resolve ("ถามฉัน") */
	ask: (repo: string, files: string[]) => `${repo}: ${files.map(name).join(', ')} ถูกแก้ทั้งสองฝั่ง — เลือกว่าจะใช้ของใคร`,
	/** policy saveCopy ("เก็บทั้งสองไว้") */
	keepBoth: (repo: string, file: string, copy: string) =>
		`${repo}: ${name(file)} ถูกแก้ทั้งสองฝั่ง — ในไฟล์เป็นของอีกคน ของคุณเก็บไว้ที่ ${name(copy)}`,
	/** policy keepMine ("ใช้ของฉัน") */
	mine: (repo: string, file: string) => `${repo}: ${name(file)} ถูกแก้ทั้งสองฝั่ง — ใช้ของคุณแล้ว`,
	theirs: (repo: string, file: string) => `${repo}: ${name(file)} ถูกแก้ทั้งสองฝั่ง — ใช้ของอีกคนแล้ว`,
	paused: (repo: string, files: string[]) => `${repo}: ${files.map(name).join(', ')} ถูกแก้ทั้งสองฝั่ง — หยุด sync ไว้จนกว่าจะเลือก`,
};

/** What to type next, shown by `korn` (mode: where conflicts open, see daemon/opener.ts) */
export const nextStep = {
	ask: (file: string, mode: 'vscode' | 'terminal' = 'vscode') =>
		mode === 'vscode' ? `เลือกใน VS Code (เปิดไฟล์ → แท็บ Resolve) หรือพิมพ์: korn resolve ${file}` : `พิมพ์: korn resolve ${file}`,
	paused: (file: string) => `พิมพ์: korn resolve ${file}`,
};
