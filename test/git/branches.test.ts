import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
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
	sh('git init -q --bare -b main remote.git'); sh('git clone -q remote.git A 2>/dev/null');
	const A = `${root}/A`;
	sh('git config user.email t@t && git config user.name t', A);

	eq('brand-new repo (no commits)', await ops.branchInfo(A), { branch: 'main', upstream: undefined, detached: false });

	writeFileSync(`${A}/note.r.md`, 'n\n');
	sh('git add . && git commit -qm init && git push -q -u origin main', A);
	eq('main with upstream', await ops.branchInfo(A), { branch: 'main', upstream: 'origin/main', detached: false });

	sh('git checkout -q -b feature/x', A);
	eq('new branch, not on remote yet', await ops.branchInfo(A), { branch: 'feature/x', upstream: undefined, detached: false });
	const states = await ops.repoFileStates(A);
	eq('  no upstream: committed file = never', states.get('note.r.md')?.state ?? 'never', 'never');
	writeFileSync(`${A}/note.r.md`, 'changed\n');
	eq('  no upstream: changed file = dirty', (await ops.repoFileStates(A)).get('note.r.md')?.state, 'dirty');
	sh('git checkout -q -- note.r.md', A);

	sh('git push -q -u origin feature/x', A);
	eq('after first push', await ops.branchInfo(A), { branch: 'feature/x', upstream: 'origin/feature/x', detached: false });

	sh('git checkout -q --detach', A);
	eq('detached HEAD', await ops.branchInfo(A), { detached: true });

	console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
})();
