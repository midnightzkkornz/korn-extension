import { execSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ops from '../../src/git/ops';
// every run works in a fresh temp folder (removed at the end)
const root = mkdtempSync(join(tmpdir(), 'korn-test-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
const read = (f: string) => readFileSync(f, 'utf8');
let failed = 0;
const eq = (name: string, a: unknown, b: unknown) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) { failed++; console.log('  got ', JSON.stringify(a)); console.log('  want', JSON.stringify(b)); } };
const A = `${root}/A`, B = `${root}/B`;
function setup() {
	rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
	sh('git init -q --bare -b main remote.git'); sh('git clone -q remote.git A 2>/dev/null'); sh('git clone -q remote.git B 2>/dev/null');
	for (const d of [A, B]) sh('git config user.email t@t && git config user.name t', d);
	writeFileSync(`${A}/a.r.md`, 'a\n'); writeFileSync(`${A}/b.r.md`, 'b\n');
	sh('git add . && git commit -qm init && git push -q -u origin main', A); sh('git pull -q', B);
}
(async () => {
	// 1. we changed nothing, B changed a.r.md -> incoming shows, pull brings it
	setup();
	writeFileSync(`${B}/a.r.md`, 'a from B\n'); sh('git commit -qam B && git push -q', B);
	sh('git fetch -q', A);
	eq('incoming listed', await ops.incomingFiles(A), ['a.r.md']);
	const st = await ops.repoFileStates(A);
	eq('state shows incoming', st.get('a.r.md')?.incoming, true);
	eq('pull clean', await ops.pullRemote(A), { pulled: true });
	eq('  got B content', read(`${A}/a.r.md`), 'a from B\n');
	eq('  nothing incoming now', await ops.incomingFiles(A), []);

	// 2. we have an uncommitted change in another file -> pulled, our change kept
	setup();
	writeFileSync(`${B}/a.r.md`, 'a from B\n'); sh('git commit -qam B && git push -q', B);
	writeFileSync(`${A}/b.r.md`, 'b mine (not committed)\n');
	sh('git fetch -q', A);
	eq('pull with other dirty file', await ops.pullRemote(A), { pulled: true });
	eq('  B content in', read(`${A}/a.r.md`), 'a from B\n');
	eq('  our dirty file kept', read(`${A}/b.r.md`), 'b mine (not committed)\n');

	// 3. we changed the SAME file without committing -> skip (left to its own Sync)
	setup();
	writeFileSync(`${B}/a.r.md`, 'a from B\n'); sh('git commit -qam B && git push -q', B);
	writeFileSync(`${A}/a.r.md`, 'a mine\n');
	sh('git fetch -q', A);
	eq('same file dirty -> skipped', await ops.pullRemote(A), { pulled: false, skipped: 'a.r.md' });
	eq('  our change untouched', read(`${A}/a.r.md`), 'a mine\n');
	eq('  no stash left behind', sh('git stash list', A).trim(), '');

	// 4. untracked local file with a name the remote just added -> skipped, file kept
	setup();
	writeFileSync(`${B}/new.r.md`, 'from B\n'); sh('git add . && git commit -qm new && git push -q', B);
	writeFileSync(`${A}/new.r.md`, 'mine\n');
	sh('git fetch -q', A);
	eq('untracked same name -> skipped', await ops.pullRemote(A), { pulled: false, skipped: 'new.r.md' });
	eq('  our file kept', read(`${A}/new.r.md`), 'mine\n');

	// 5. we have an unpushed commit that conflicts -> reported, repo restored
	setup();
	writeFileSync(`${B}/a.r.md`, 'a from B\n'); sh('git commit -qam B && git push -q', B);
	writeFileSync(`${A}/a.r.md`, 'a from A\n'); sh('git commit -qam A', A);
	sh('git fetch -q', A);
	eq('committed conflict -> reported', await ops.pullRemote(A), { pulled: false, conflictFile: 'a.r.md' });
	eq('  no rebase left', await ops.operationInProgress(A), false);
	eq('  our commit kept', read(`${A}/a.r.md`), 'a from A\n');

	// 6. nothing new -> no-op
	setup();
	eq('up to date -> no-op', await ops.pullRemote(A), { pulled: false });
	console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
})();
