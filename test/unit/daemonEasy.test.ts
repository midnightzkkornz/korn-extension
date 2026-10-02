import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initConfig, parseConfig, presetOf, setRepoOptions } from '../../daemon/config';
import { conflictMessage, nextStep } from '../../daemon/messages';
import { describe, Overview } from '../../daemon/overview';
import { launchAgentPlist, systemdUnit } from '../../daemon/service';

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

// ---- presets ↔ config ----
const repoOf = (yaml: string) => parseConfig(`repos:\n  - path: /n\n${yaml}`).repos[0];
eq('defaults = keep both + normal', presetOf(repoOf('')), { conflict: 'keepBoth', frequency: 'normal' });
eq('ask + fast', presetOf(repoOf('    conflict: resolve\n    quietMinutes: 1\n    pullEveryMinutes: 2\n')), { conflict: 'ask', frequency: 'fast' });
eq('hand-set values = custom', presetOf(repoOf('    conflict: pause\n    quietMinutes: 3\n')), { conflict: 'custom', frequency: 'custom' });

const dir = mkdtempSync(join(tmpdir(), 'korn-easy-'));
const file = join(dir, 'config.yaml');
initConfig(file);
setRepoOptions('/n/notes', { conflict: 'ask', frequency: 'relaxed' }, file);
let repo = parseConfig(readFileSync(file, 'utf8')).repos[0];
eq('setRepoOptions adds the repo with presets', [repo.path, repo.conflict, repo.quietMinutes, repo.pullEveryMinutes], ['/n/notes', 'resolve', 15, 30]);
writeFileSync(file, readFileSync(file, 'utf8').replace('pullEveryMinutes: 30', 'pullEveryMinutes: 30\n    exclude: ["drafts/**"]  # mine'));
setRepoOptions('/n/notes', { frequency: 'fast' }, file);
repo = parseConfig(readFileSync(file, 'utf8')).repos[0];
eq('changing one keeps the rest', [repo.conflict, repo.quietMinutes, repo.exclude], ['resolve', 1, ['drafts/**']]);
eq('comments kept', readFileSync(file, 'utf8').includes('# mine') && readFileSync(file, 'utf8').includes('# Korn daemon'), true);
eq('still one repo', parseConfig(readFileSync(file, 'utf8')).repos.length, 1);
rmSync(dir, { recursive: true, force: true });

// ---- service files ----
const plist = launchAgentPlist('/opt/homebrew/bin/node', '/Users/me/.local/share/korn/korn.js', {}, '/tmp/korn & log.txt');
eq('plist runs korn daemon', plist.includes('<string>/opt/homebrew/bin/node</string>\n\t\t<string>/Users/me/.local/share/korn/korn.js</string>\n\t\t<string>daemon</string>'), true);
eq('plist starts at login and restarts', plist.includes('<key>RunAtLoad</key>\n\t<true/>') && plist.includes('<key>KeepAlive</key>\n\t<true/>'), true);
eq('plist escapes xml', plist.includes('/tmp/korn &amp; log.txt'), true);
eq('plist PATH has homebrew', plist.includes('<string>/opt/homebrew/bin:/usr/local/bin'), true);
const electron = launchAgentPlist('/Applications/Code.app/helper', '/k.js', { ELECTRON_RUN_AS_NODE: '1' }, '/l');
eq('plist with VS Code runtime', electron.includes('<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>'), true);
const unit = systemdUnit('/usr/bin/node', '/home/me/korn.js', {});
eq('systemd unit', [unit.includes('ExecStart="/usr/bin/node" "/home/me/korn.js" daemon'), unit.includes('Restart=always')], [true, true]);

// ---- messages ----
eq('ask message', conflictMessage.ask('my-notes', ['notes/note.r.md']), 'my-notes: note.r.md ถูกแก้ทั้งสองฝั่ง — เลือกว่าจะใช้ของใคร');
eq('keep both message', conflictMessage.keepBoth('my-notes', 'note.r.md', 'note.conflict-20261001-1641.r.md'), 'my-notes: note.r.md ถูกแก้ทั้งสองฝั่ง — ในไฟล์เป็นของอีกคน ของคุณเก็บไว้ที่ note.conflict-20261001-1641.r.md');
eq('next step', nextStep.ask('note.r.md'), 'เลือกใน VS Code (เปิดไฟล์ → แท็บ Resolve) หรือพิมพ์: korn resolve note.r.md');

// ---- `korn` summary: always says what to do next ----
const base: Overview = { running: true, service: true, configPath: '/c', configured: true, repos: [] };
eq('not set up', describe({ ...base, configured: false }), 'ยังไม่ได้ตั้งค่า — พิมพ์: korn setup');
eq('bad config', describe({ ...base, configured: false, configError: 'line 3: x' }), '⚠ ตั้งค่าผิด: line 3: x');
eq('no repos', describe(base), 'ยังไม่มี repo — พิมพ์: korn setup');
const repoView = { path: '/n/my-notes', name: 'my-notes', branch: 'main', conflict: 'ask' as const, frequency: 'normal' as const, waiting: [], needsChoice: [], notices: [] };
eq('off → korn start', describe({ ...base, running: false, service: false, repos: [repoView] }).split('\n')[0], '○ sync เบื้องหลังปิดอยู่ — พิมพ์: korn start');
const withConflict = describe({
	...base,
	repos: [{ ...repoView, needsChoice: [{ file: 'note.r.md', path: '/n/my-notes/note.r.md', kind: 'ask', next: nextStep.ask('note.r.md') }] }],
});
eq('conflict → next step', withConflict.split('\n').slice(-1)[0], '  ⚠ note.r.md ถูกแก้ทั้งสองฝั่ง ต้องเลือก → เลือกใน VS Code (เปิดไฟล์ → แท็บ Resolve) หรือพิมพ์: korn resolve note.r.md');
eq('running line', withConflict.split('\n')[0], '✓ sync เบื้องหลังทำงานอยู่');

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
