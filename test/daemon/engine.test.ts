import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseConfig, RepoConfig } from '../../daemon/config';
import { conflictCopyName, finishMergeResolve, resolvePaused, runRound } from '../../daemon/engine';
import { readPaused, setPaused } from '../../daemon/state';
import { lockPath } from '../../src/git/lock';

// The daemon's sync round against real git repos: A = this machine (daemon), B = someone else
const root = mkdtempSync(join(tmpdir(), 'korn-daemon-test-'));
process.env.KORN_STATE_DIR = join(root, 'state');
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const read = (f: string) => readFileSync(f, 'utf8');
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
const A = `${root}/A`;
const B = `${root}/B`;
const MIN = 60_000;

function setup() {
	for (const d of ['remote.git', 'A', 'B', 'state']) {
		rmSync(join(root, d), { recursive: true, force: true });
	}
	sh('git init -q --bare -b main remote.git');
	sh('git clone -q remote.git A 2>/dev/null');
	sh('git clone -q remote.git B 2>/dev/null');
	for (const d of [A, B]) {
		sh('git config user.email t@t && git config user.name t', d);
	}
	writeFileSync(`${A}/a.md`, 'line 1\nline 2\nline 3\n');
	writeFileSync(`${A}/b.md`, 'b\n');
	sh('git add . && git commit -qm init && git push -q -u origin main', A);
	sh('git pull -q', B);
}

// Change a file and make it look `minutesAgo` old
function edit(file: string, content: string, minutesAgo = 10) {
	mkdirSync(join(file, '..'), { recursive: true });
	writeFileSync(file, content);
	const t = (Date.now() - minutesAgo * MIN) / 1000;
	utimesSync(file, t, t);
}
function othersPush(file: string, content: string) {
	writeFileSync(`${B}/${file}`, content);
	sh(`git add -A && git commit -qm other && git push -q`, B);
}
const remoteFile = (file: string) => {
	try {
		return sh(`git --git-dir=remote.git show main:${file}`);
	} catch {
		return undefined;
	}
};
const config = (extra = ''): RepoConfig => parseConfig(`repos:\n  - path: ${A}\n${extra}`).repos[0];

(async () => {
	// 1. quiet time: not committed while being edited, committed + pushed once quiet
	setup();
	edit(`${A}/a.md`, 'mine\n', 1);
	let r = await runRound(config());
	eq('recent edit waits', [r.committed, r.waiting.map((w) => w.file), r.pushed], [[], ['a.md'], false]);
	r = await runRound(config(), { now: Date.now() + 5 * MIN });
	eq('quiet → committed + pushed', [r.committed, r.pushed], [['a.md'], true]);
	eq('  on the remote', remoteFile('a.md'), 'mine\n');
	eq('  commit message', sh('git log -1 --format=%s', A).startsWith('update a.md - '), true);

	// 2. only included files; excluded, non-.md and files with conflict markers stay local
	setup();
	edit(`${A}/notes.txt`, 'x\n');
	edit(`${A}/drafts/d.md`, 'd\n');
	edit(`${A}/new/n.md`, 'n\n');
	edit(`${A}/b.md`, '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n');
	r = await runRound(config('    exclude: ["drafts/**"]\n'));
	eq('only the included, clean file', r.committed, ['new/n.md']);
	eq('  others still uncommitted', sh('git status --porcelain', A).split('\n').filter(Boolean).sort(), [' M b.md', '?? drafts/', '?? notes.txt']);

	// 3. deleted file is synced right away
	setup();
	rmSync(`${A}/b.md`);
	r = await runRound(config());
	eq('deletion synced', [r.committed, remoteFile('b.md')], [['b.md'], undefined]);

	// 4. user-paused file is not committed
	setup();
	await setPaused(A, 'a.md', { reason: 'user', since: new Date().toISOString() });
	edit(`${A}/a.md`, 'paused edit\n');
	r = await runRound(config());
	eq('paused file skipped', r.committed, []);
	await setPaused(A, 'a.md', undefined);

	// 5. pulls others' changes on schedule (nothing of ours to send)
	setup();
	othersPush('b.md', 'b from B\n');
	r = await runRound(config());
	eq('pulled', [r.pulled, read(`${A}/b.md`)], [true, 'b from B\n']);
	othersPush('b.md', 'b again\n');
	r = await runRound(config());
	eq('not again before pullEveryMinutes', [r.pulled, read(`${A}/b.md`)], [false, 'b from B\n']);
	r = await runRound(config(), { now: Date.now() + 11 * MIN });
	eq('again after pullEveryMinutes', [r.pulled, read(`${A}/b.md`)], [true, 'b again\n']);

	// 6. different lines → merged, no conflict
	setup();
	othersPush('a.md', 'line 1 B\nline 2\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nline 2\nline 3 A\n');
	r = await runRound(config());
	eq('auto-merged', [r.resolved, r.pushed, read(`${A}/a.md`)], [[], true, 'line 1 B\nline 2\nline 3 A\n']);

	// 7. conflict: saveCopy (default) → remote version in the file, ours in a copy
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n');
	r = await runRound(config());
	const copy = readdirSync(A).find((f) => f.startsWith('a.conflict-'));
	eq('saveCopy: file = remote', read(`${A}/a.md`), 'line 1\nB\nline 3\n');
	eq('saveCopy: copy = mine', copy && read(`${A}/${copy}`), 'line 1\nA\nline 3\n');
	eq('saveCopy: copy name', /^a\.conflict-\d{8}-\d{4}\.md$/.test(copy ?? ''), true);
	eq('saveCopy: pushed both', [r.pushed, remoteFile(copy ?? '')], [true, 'line 1\nA\nline 3\n']);
	eq('saveCopy: reported', r.resolved, [{ file: 'a.md', policy: 'saveCopy' }]);

	// 8. conflict: keepMine via a rule, keepTheirs for the repo
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n');
	r = await runRound(config('    conflict: keepTheirs\n    rules:\n      - match: "a.md"\n        conflict: keepMine\n'));
	eq('keepMine (rule)', [read(`${A}/a.md`), remoteFile('a.md')], ['line 1\nA\nline 3\n', 'line 1\nA\nline 3\n']);
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n');
	r = await runRound(config('    conflict: keepTheirs\n'));
	// our change is dropped, so there's nothing left to push
	eq('keepTheirs', [read(`${A}/a.md`), remoteFile('a.md'), r.resolved], ['line 1\nB\nline 3\n', 'line 1\nB\nline 3\n', [{ file: 'a.md', policy: 'keepTheirs' }]]);
	eq('keepTheirs: nothing left to push', [r.pushed, sh('git status -sb', A).includes('ahead')], [false, false]);

	// 9. conflict: pause → nothing pushed until korn resolve
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n');
	edit(`${A}/b.md`, 'b mine\n');
	r = await runRound(config('    conflict: pause\n'));
	eq('pause: paused, not pushed', [r.paused, r.pushed, remoteFile('b.md')], [['a.md'], false, 'b\n']);
	eq('pause: recorded', Object.keys(await readPaused(A)), ['a.md']);
	eq('pause: our version still here', read(`${A}/a.md`), 'line 1\nA\nline 3\n');
	r = await runRound(config('    conflict: pause\n'), { force: true });
	eq('pause: later rounds wait', [r.pushed, r.skipped], [false, 'waiting for "korn resolve" on a.md']);
	const summary = await resolvePaused(config('    conflict: pause\n'), ['a.md'], 'mine');
	eq('resolve --mine', [read(`${A}/a.md`), remoteFile('a.md'), remoteFile('b.md')], ['line 1\nA\nline 3\n', 'line 1\nA\nline 3\n', 'b mine\n']);
	eq('resolve: pushed + unpaused', [summary.endsWith('pushed'), Object.keys(await readPaused(A))], [true, []]);

	// 10. our uncommitted edit collides with an incoming change → wait until it's committed
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n', 1); // still being edited
	edit(`${A}/b.md`, 'b mine\n');
	r = await runRound(config());
	eq('overlap: b committed, nothing pushed yet', [r.committed, r.pushed], [['b.md'], false]);
	eq('overlap: reason', r.skipped, 'a.md changed here and on the remote — syncing after it\'s committed');
	r = await runRound(config(), { now: Date.now() + 5 * MIN });
	eq('overlap: once quiet → conflict handled + pushed', [r.resolved.length, r.pushed, remoteFile('b.md')], [1, true, 'b mine\n']);

	// 11. lock held by another live process → skip; stale lock → taken over
	setup();
	edit(`${A}/a.md`, 'mine\n');
	const lock = await lockPath(A);
	writeFileSync(lock, JSON.stringify({ pid: process.ppid, owner: 'extension', time: Date.now() }));
	r = await runRound(config());
	eq('busy → skipped', [r.skipped, r.committed], ['extension is syncing', []]);
	writeFileSync(lock, JSON.stringify({ pid: 999999, owner: 'extension', time: Date.now() }));
	r = await runRound(config());
	eq('stale lock taken over', [r.committed, r.pushed, existsSync(lock)], [['a.md'], true, false]);

	// 12. merge in progress (e.g. "Resolve in Korn" open in VS Code) → leave the repo alone
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	writeFileSync(`${A}/a.md`, 'line 1\nA\nline 3\n');
	sh('git commit -qam mine && git fetch -q && (git merge origin/main >/dev/null 2>&1 || true)', A);
	r = await runRound(config());
	eq('merge in progress → skipped', r.skipped, 'waiting for the conflict to be resolved: a.md');

	// 13. first push of a new branch creates it on the remote
	setup();
	sh('git checkout -q -b topic', A);
	edit(`${A}/a.md`, 'topic\n');
	r = await runRound(config());
	eq('new branch pushed', [r.pushed, sh('git --git-dir=remote.git show topic:a.md')], [true, 'topic\n']);

	// 15. conflict: resolve → markers left (like "Resolve in Korn"), nothing pushed until finished
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n');
	const resolveCfg = config('    conflict: resolve\n');
	r = await runRound(resolveCfg);
	eq('resolve: merge left open', [r.merging, r.pushed], [['a.md'], false]);
	eq('resolve: diff3 markers in the file', /<<<<<<<[^]*\|\|\|\|\|\|\|[^]*=======[^]*>>>>>>>/.test(read(`${A}/a.md`)), true);
	r = await runRound(resolveCfg, { force: true });
	eq('resolve: later rounds wait', r.skipped, 'waiting for the conflict to be resolved: a.md');
	let msg = await finishMergeResolve(resolveCfg, [{ file: 'a.md', text: 'line 1\nA and B\nline 3\n' }]);
	eq('resolve: finished + pushed', [msg, remoteFile('a.md')], ['merged a.md · pushed', 'line 1\nA and B\nline 3\n']);
	r = await runRound(resolveCfg, { force: true });
	eq('resolve: back to normal', [r.skipped, r.error], [undefined, undefined]);

	// 16. markers removed by hand (any editor) → concluded once quiet, then pushed
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n');
	await runRound(resolveCfg);
	edit(`${A}/a.md`, 'line 1\nby hand\nline 3\n', 1);
	r = await runRound(resolveCfg);
	eq('by hand: waits while being edited', r.skipped, 'waiting for the conflict to be resolved: a.md');
	r = await runRound(resolveCfg, { now: Date.now() + 5 * MIN });
	eq('by hand: concluded + pushed', [r.pushed, remoteFile('a.md')], [true, 'line 1\nby hand\nline 3\n']);

	// 17. finishing only some of the files keeps the merge open
	setup();
	othersPush('a.md', 'line 1\nB\nline 3\n');
	othersPush('b.md', 'b B\n');
	edit(`${A}/a.md`, 'line 1\nA\nline 3\n');
	edit(`${A}/b.md`, 'b A\n');
	r = await runRound(resolveCfg);
	eq('two files in one merge', r.merging.sort(), ['a.md', 'b.md']);
	msg = await finishMergeResolve(resolveCfg, [{ file: 'a.md', text: 'line 1\nA\nline 3\n' }]);
	eq('one left', msg, 'บันทึกแล้ว ยังเหลือ conflict ใน b.md — korn resolve b.md');
	msg = await finishMergeResolve(resolveCfg, [{ file: 'b.md', text: 'b B\n' }]);
	eq('all done → pushed', [msg, remoteFile('a.md'), remoteFile('b.md')], ['merged a.md, b.md · pushed', 'line 1\nA\nline 3\n', 'b B\n']);

	// 18. copy names keep .r.md so the copy opens in Korn
	const t = new Date(2026, 9, 1, 16, 41);
	eq('copy name .r.md', conflictCopyName(A, 'notes/note.r.md', t), 'notes/note.conflict-20261001-1641.r.md');
	eq('copy name .md', conflictCopyName(A, 'a.md', t), 'a.conflict-20261001-1641.md');

	// 14. not a repo → error, reported
	r = await runRound({ ...config(), path: join(root, 'nope') });
	eq('missing folder → error', r.error?.startsWith('ไม่พบโฟลเดอร์'), true);

	console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
})().catch((error) => {
	console.log(`FAIL crashed: ${error.stack ?? error}`);
});
