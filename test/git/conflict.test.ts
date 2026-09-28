import { execSync } from 'child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseConflicts, buildResult } from '../../webview/editor/resolve/conflictParser';
import * as ops from '../../src/git/ops';

// every run works in a fresh temp folder (removed at the end)
const root = mkdtempSync(join(tmpdir(), 'korn-test-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const A = `${root}/A`, B = `${root}/B`;
const read = (f: string) => readFileSync(f, 'utf8');
let failed = 0;
const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) failed++; };

function setup() {
	rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
	sh('git init -q --bare -b main remote.git');
	sh('git clone -q remote.git A'); sh('git clone -q remote.git B');
	for (const d of [A, B]) sh('git config user.email t@t && git config user.name t', d);
	writeFileSync(`${A}/note.r.md`, '# Note\n\nline one\nline two\n'); writeFileSync(`${A}/other.md`, 'x\n');
	sh('git add . && git commit -qm init && git push -q -u origin main', A);
	sh('git pull -q', B);
}
// mirrors gitSync.syncFile
async function sync(cwd: string, file: string) {
	let merged = false;
	const state = await ops.mergeState(cwd, file);
	if (state === 'unresolved' || state === 'rebase') throw new Error(state);
	if (state === 'resolved') { await ops.finishMerge(cwd, file); merged = true; }
	else await ops.commitFile(cwd, file, new Date());
	sh('git fetch -q', cwd);
	if (await ops.behindCount(cwd) > 0) { if (await ops.integrate(cwd, file, merged) === 'conflict') return 'conflict'; }
	sh('git push -q', cwd); return 'synced';
}
function makeConflict() {
	writeFileSync(`${B}/note.r.md`, '# Note\n\nline one from B\nline two\n'); sh('git commit -qam B && git push -q', B);
	writeFileSync(`${A}/note.r.md`, '# Note\n\nline one from A\nline two\n');
}
const remoteFile = (f: string) => sh(`git --git-dir=remote.git show main:${f}`);

(async () => {
	// 1. remote changed another file -> auto integrate, no conflict
	setup();
	writeFileSync(`${B}/other.md`, 'changed by B\n'); sh('git commit -qam B-other && git push -q', B);
	writeFileSync(`${A}/note.r.md`, '# Note\n\nline one A\nline two\n');
	writeFileSync(`${A}/dirty.txt`, 'uncommitted\n'); sh('git add dirty.txt', A); writeFileSync(`${A}/other2.md`, 'untracked\n');
	check('auto-integrate other file', await sync(A, 'note.r.md') === 'synced');
	check('  remote has A note', remoteFile('note.r.md').includes('line one A'));
	check('  A has B other.md', read(`${A}/other.md`) === 'changed by B\n');
	check('  dirty files kept', read(`${A}/dirty.txt`) === 'uncommitted\n' && read(`${A}/other2.md`) === 'untracked\n');

	// 2. same file, different lines -> auto merge
	setup();
	writeFileSync(`${B}/note.r.md`, '# Note\n\nline one\nline two B\n'); sh('git commit -qam B && git push -q', B);
	writeFileSync(`${A}/note.r.md`, '# Note A\n\nline one\nline two\n');
	check('auto-merge same file diff lines', await sync(A, 'note.r.md') === 'synced');
	check('  merged content', remoteFile('note.r.md') === '# Note A\n\nline one\nline two B\n');

	// 3. real conflict -> detected, repo clean
	setup(); makeConflict();
	check('conflict detected', await sync(A, 'note.r.md') === 'conflict');
	check('  no rebase in progress', !(await ops.operationInProgress(A)));
	check('  A file still mine', read(`${A}/note.r.md`).includes('from A'));

	// 4. keep mine
	sh('git fetch -q', A);
	await ops.keepMine(A, 'note.r.md', new Date()); sh('git push -q', A);
	check('keepMine: remote = mine', remoteFile('note.r.md') === '# Note\n\nline one from A\nline two\n');

	// 5. save copy
	setup(); makeConflict();
	check('conflict again', await sync(A, 'note.r.md') === 'conflict');
	sh('git fetch -q', A);
	const msg = await ops.saveCopy(A, 'note.r.md', 'note-copy.r.md', new Date()); sh('git push -q', A);
	check('saveCopy: remote note = B', remoteFile('note.r.md') === '# Note\n\nline one from B\nline two\n');
	check('saveCopy: remote copy = A', remoteFile('note-copy.r.md') === '# Note\n\nline one from A\nline two\n', msg);

	// 6. resolve via merge
	setup(); makeConflict();
	await sync(A, 'note.r.md'); sh('git fetch -q', A);
	writeFileSync(`${A}/dirty.txt`, 'wip\n');
	await ops.startMerge(A);
	check('startMerge: merge in progress', await ops.operationInProgress(A));
	check('  conflict markers', read(`${A}/note.r.md`).includes('<<<<<<<'));
	check('  mergeState = unresolved', await ops.mergeState(A, 'note.r.md') === 'unresolved');
	let threw = false; try { await sync(A, 'note.r.md'); } catch { threw = true; }
	check('  sync refuses while markers remain', threw);
	// user removes markers but does NOT stage or commit (Sync should finish the merge)
	writeFileSync(`${A}/note.r.md`, '# Note\n\nline one from A and B\nline two\n');
	check('  mergeState = resolved', await ops.mergeState(A, 'note.r.md') === 'resolved');
	check('  after resolve: sync ok', await sync(A, 'note.r.md') === 'synced');
	check('  remote resolved', remoteFile('note.r.md').includes('from A and B'));
	check('  merge finished', await ops.mergeState(A, 'note.r.md') === 'none');
	check('  merge commit kept', sh('git log -1 --format=%P', A).trim().split(' ').length === 2);
	check('  dirty file kept', read(`${A}/dirty.txt`) === 'wip\n');

	// 7. resolved merge, but remote moved again meanwhile (B edits another line) -> merge, not rebase
	setup(); makeConflict();
	await sync(A, 'note.r.md'); sh('git fetch -q', A); await ops.startMerge(A);
	writeFileSync(`${A}/note.r.md`, '# Note\n\nline one from A and B\nline two\n');
	sh('git pull -q --rebase', B); writeFileSync(`${B}/other.md`, 'B again\n'); sh('git commit -qam B2 && git push -q', B);
	check('resolved + remote moved: sync ok', await sync(A, 'note.r.md') === 'synced');
	check('  remote has both', remoteFile('note.r.md').includes('from A and B') && remoteFile('other.md') === 'B again\n');

	// 8. Resolve in Korn: 2 conflicts, diff3 markers parsed, different choice per conflict
	setup();
	writeFileSync(`${A}/note.r.md`, '# Note\n\na\nkeep\nb\n'); sh('git commit -qam base && git push -q', A); sh('git pull -q', B);
	writeFileSync(`${B}/note.r.md`, '# Note\n\na-B\nkeep\nb-B\n'); sh('git commit -qam B && git push -q', B);
	writeFileSync(`${A}/note.r.md`, '# Note\n\na-A\nkeep\nb-A\n');
	check('korn resolve: conflict', await sync(A, 'note.r.md') === 'conflict');
	sh('git fetch -q', A); await ops.startMerge(A);
	const segs = parseConflicts(read(`${A}/note.r.md`));
	const cs = (segs ?? []).filter((x) => x.kind === 'conflict') as any[];
	check('  parsed 2 conflicts', cs.length === 2, JSON.stringify(cs.map((c) => [c.mine, c.base, c.theirs])));
	check('  diff3 base present', cs.length === 2 && cs[0].base === 'a\n' && cs[1].base === 'b\n');
	writeFileSync(`${A}/note.r.md`, buildResult(segs!, [{ type: 'theirs' }, { type: 'mineFirst' }]));
	check('  mergeState resolved', await ops.mergeState(A, 'note.r.md') === 'resolved');
	check('  sync ok', await sync(A, 'note.r.md') === 'synced');
	check('  remote = chosen result', remoteFile('note.r.md') === '# Note\n\na-B\nkeep\nb-A\nb-B\n', JSON.stringify(remoteFile('note.r.md')));

	// 10. switching options (mirrors gitSync.resolveConflict: abort a running "Resolve in Korn" first)
	const resolveLike = async (cwd: string, file: string, action: 'keepMine' | 'saveCopy' | 'cancel', copy = 'note-copy.r.md') => {
		const st = await ops.mergeState(cwd, file);
		const merging = st === 'unresolved' || st === 'resolved';
		if (action === 'cancel') { if (merging) await ops.abortMerge(cwd); return 'cancelled'; }
		if (merging) await ops.abortMerge(cwd);
		sh('git fetch -q', cwd);
		if ((await ops.behindCount(cwd)) === 0) return 'noConflict';
		if (action === 'keepMine') await ops.keepMine(cwd, file, new Date()); else await ops.saveCopy(cwd, file, copy, new Date());
		sh('git push -q', cwd);
		return 'synced';
	};

	setup(); makeConflict();
	writeFileSync(`${A}/wip.txt`, 'work in progress\n');
	await sync(A, 'note.r.md'); sh('git fetch -q', A); await ops.startMerge(A);
	check('switch 3→1: merge running', await ops.mergeState(A, 'note.r.md') === 'unresolved');
	check('switch 3→1: synced', await resolveLike(A, 'note.r.md', 'keepMine') === 'synced');
	check('  remote = mine', remoteFile('note.r.md') === '# Note\n\nline one from A\nline two\n');
	check('  no merge left', !(await ops.operationInProgress(A)));
	check('  wip kept', read(`${A}/wip.txt`) === 'work in progress\n');

	setup(); makeConflict();
	await sync(A, 'note.r.md'); sh('git fetch -q', A); await ops.startMerge(A);
	check('switch 3→2: synced', await resolveLike(A, 'note.r.md', 'saveCopy') === 'synced');
	check('  remote note = theirs, copy = mine', remoteFile('note.r.md').includes('from B') && remoteFile('note-copy.r.md').includes('from A'));

	setup(); makeConflict();
	writeFileSync(`${A}/wip.txt`, 'wip 2\n');
	await sync(A, 'note.r.md'); sh('git fetch -q', A); await ops.startMerge(A);
	check('cancel: returns', await resolveLike(A, 'note.r.md', 'cancel') === 'cancelled');
	check('  mergeState none', await ops.mergeState(A, 'note.r.md') === 'none');
	check('  file back to mine', read(`${A}/note.r.md`) === '# Note\n\nline one from A\nline two\n');
	check('  wip kept', read(`${A}/wip.txt`) === 'wip 2\n');
	check('  can choose again (keepMine)', await resolveLike(A, 'note.r.md', 'keepMine') === 'synced' && remoteFile('note.r.md').includes('from A'));

	check('already handled → noConflict', await resolveLike(A, 'note.r.md', 'saveCopy', 'extra-copy.r.md') === 'noConflict');
	check('  no extra copy created', !sh('git ls-files', A).includes('extra-copy'));

	console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
	process.exit(failed ? 1 : 0);
})();
