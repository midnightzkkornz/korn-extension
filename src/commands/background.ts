import * as vscode from 'vscode';
import { ctx } from '../context';

// Background sync (the korn daemon bundled as out/korn.js): commands, and one offer after the first Sync

const ASKED_KEY = 'korn.background.offered';

/** After a manual Sync succeeds: offer background sync once (never again after any answer) */
export async function offerBackgroundSync(state: vscode.Memento) {
	if (state.get(ASKED_KEY) || !(process.platform === 'darwin' || process.platform === 'linux')) {
		return;
	}
	await state.update(ASKED_KEY, true);
	const view = await ctx.background.view();
	if (view.on) {
		return;
	}
	const choice = await vscode.window.showInformationMessage(
		'อยากให้ Korn sync ต่อแม้ปิด VS Code ไหม? (ตั้งค่าได้ที่แผง Korn Sync)',
		'เปิด',
		'ไม่ต้อง'
	);
	if (choice === 'เปิด') {
		await ctx.background.toggle(true, () => ctx.panel.refreshBackground());
	}
}

export function registerBackgroundCommands(): vscode.Disposable[] {
	const refresh = () => ctx.panel.refreshBackground();
	return [
		vscode.commands.registerCommand('korn.background.on', () => ctx.background.toggle(true, refresh)),
		vscode.commands.registerCommand('korn.background.off', () => ctx.background.toggle(false, refresh)),
		vscode.commands.registerCommand('korn.background.installCommand', () => ctx.background.installCommand()),
	];
}
