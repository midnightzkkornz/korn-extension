import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chooseChannel, dialogScript, parseDialogResult } from '../../daemon/notify';
import { appendEvent, folderShowsRepo, readEvents, removeHeartbeat, vscodeShowsRepo, writeHeartbeat } from '../../src/shared/daemonBridge';

let failed = 0;
const eq = (name: string, a: unknown, b: unknown) => {
	const ok = JSON.stringify(a) === JSON.stringify(b);
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
	if (!ok) {
		failed++;
		console.log('  got ', JSON.stringify(a));
		console.log('  want', JSON.stringify(b));
	}
};

// ---- where a notification goes ----
eq('auto + VS Code open → VS Code', chooseChannel('conflict', 'auto', true), 'vscode');
eq('auto + closed → dialog', chooseChannel('conflict', 'auto', false), 'dialog');
eq('auto error → banner', chooseChannel('error', 'auto', true), 'banner');
eq('dialog setting → dialog even with VS Code', chooseChannel('conflict', 'dialog', true), 'dialog');
eq('banner setting → banner', chooseChannel('conflict', 'banner', true), 'banner');
eq('off → nothing', [chooseChannel('conflict', 'off', true), chooseChannel('error', 'off', false)], ['none', 'none']);

// ---- dialog ----
eq(
	'dialog script',
	dialogScript('my-notes: conflict ใน "note.r.md"'),
	'display dialog "my-notes: conflict ใน \\"note.r.md\\"" with title "Korn" buttons {"ไว้ก่อน", "เลือกเลย"} default button "เลือกเลย" giving up after 60'
);
eq('clicked the button', parseDialogResult('button returned:เลือกเลย, gave up:false\n'), 'open');
eq('clicked later', parseDialogResult('button returned:ไว้ก่อน, gave up:false\n'), 'later');
eq('custom button', [dialogScript('m', 'เปิดดู').includes('default button "เปิดดู"'), parseDialogResult('button returned:เปิดดู, gave up:false', 'เปิดดู')], [true, 'open']);
eq('timed out', parseDialogResult('button returned:, gave up:true\n'), 'timeout');
if (process.platform === 'darwin') {
	// the script compiles (without showing anything): osacompile only parses it
	const out = join(mkdtempSync(join(tmpdir(), 'korn-osa-')), 'x.scpt');
	let compiles = true;
	try {
		execFileSync('osacompile', ['-o', out, '-e', dialogScript('a "quoted"\nline\\ ไทย')], { stdio: 'pipe' });
	} catch {
		compiles = false;
	}
	eq('dialog script is valid AppleScript', compiles, true);
}

// ---- bridge files (heartbeat + events) ----
const dir = mkdtempSync(join(tmpdir(), 'korn-bridge-'));
process.env.KORN_STATE_DIR = dir;

eq('repo = folder', folderShowsRepo('/n/my-notes', '/n/my-notes'), true);
eq('folder inside repo', folderShowsRepo('/n/my-notes/sub', '/n/my-notes'), true);
eq('repo inside folder', folderShowsRepo('/n', '/n/my-notes'), true);
eq('similar name ≠ same', folderShowsRepo('/n/my-notes-2', '/n/my-notes'), false);

eq('no heartbeat → not open', vscodeShowsRepo('/n/my-notes'), false);
writeHeartbeat(['/n/my-notes']);
eq('heartbeat → open', vscodeShowsRepo('/n/my-notes'), true);
eq('other repo → not open', vscodeShowsRepo('/n/other'), false);
eq('stale heartbeat → not open', vscodeShowsRepo('/n/my-notes', Date.now() + 2 * 60_000), false);
eq('  stale file cleaned up', readdirSync(join(dir, 'vscode')), []);
mkdirSync(join(dir, 'vscode'), { recursive: true });
writeFileSync(join(dir, 'vscode', '999999.json'), JSON.stringify({ pid: 999999, folders: ['/n/my-notes'], time: Date.now() }));
eq('closed window (dead pid) → not open', vscodeShowsRepo('/n/my-notes'), false);
writeHeartbeat(['/n/my-notes']);
removeHeartbeat();
eq('removed on close', vscodeShowsRepo('/n/my-notes'), false);

const first = appendEvent({ repo: '/n/r', file: '/n/r/a.md', message: 'one' });
const second = appendEvent({ repo: '/n/r', file: '/n/r/b.md', message: 'two' });
eq('ids increase', second.id > first.id, true);
eq('read back', readEvents().map((e) => e.message), ['one', 'two']);
eq('only new ones', readEvents().filter((e) => e.id > first.id).map((e) => e.message), ['two']);
for (let i = 0; i < 60; i++) {
	appendEvent({ repo: '/n/r', file: '/n/r/a.md', message: `m${i}` });
}
eq('keeps the last 50', [readEvents().length, readEvents()[49].message], [50, 'm59']);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
