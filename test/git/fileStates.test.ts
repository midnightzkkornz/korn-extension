import { execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ops from '../../src/git/ops';
// every run works in a fresh temp folder (removed at the end)
const root = mkdtempSync(join(tmpdir(), 'korn-test-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
const sh = (cmd: string, cwd = root) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();
let failed = 0;
const eq = (name: string, a: unknown, b: unknown) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) { failed++; console.log('  got ', JSON.stringify(a)); console.log('  want', JSON.stringify(b)); } };
(async () => {
	rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
	sh('git init -q --bare -b main remote.git'); sh('git clone -q remote.git A 2>/dev/null');
	const A = `${root}/A`;
	sh('git config user.email t@t && git config user.name t', A);
	mkdirSync(`${A}/sub`);
	for (const f of ['synced.r.md', 'dirty.r.md', 'ahead.r.md', 'sub/ไทย.r.md', 'other.md']) writeFileSync(`${A}/${f}`, 'x\n');
	sh('git add . && git commit -qm init && git push -q -u origin main', A);
	writeFileSync(`${A}/dirty.r.md`, 'changed\n');
	writeFileSync(`${A}/ahead.r.md`, 'y\n'); sh('git commit -qm ahead -- ahead.r.md', A);
	writeFileSync(`${A}/new file.r.md`, 'n\n');
	writeFileSync(`${A}/other.md`, 'changed\n');
	const m = await ops.repoFileStates(A);
	const st = (f: string) => m.get(f)?.state ?? 'never';
	eq('synced', st('synced.r.md'), 'synced');
	eq('synced has time', typeof m.get('synced.r.md')?.lastSync, 'string');
	eq('dirty', st('dirty.r.md'), 'dirty');
	eq('ahead', st('ahead.r.md'), 'ahead');
	eq('thai name in subfolder', st('sub/ไทย.r.md'), 'synced');
	eq('untracked with space', st('new file.r.md'), 'dirty');
	eq('non .r.md ignored', m.has('other.md'), false);

	// no upstream
	sh('git init -q -b main B', root); const B = `${root}/B`;
	sh('git config user.email t@t && git config user.name t', B);
	writeFileSync(`${B}/a.r.md`, 'a\n'); sh('git add . && git commit -qm a', B); writeFileSync(`${B}/b.r.md`, 'b\n');
	const mb = await ops.repoFileStates(B);
	eq('no upstream: committed = never', mb.get('a.r.md')?.state ?? 'never', 'never');
	eq('no upstream: untracked = dirty', mb.get('b.r.md')?.state, 'dirty');
	console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
})();
