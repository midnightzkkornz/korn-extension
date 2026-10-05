import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeCommand } from '../../daemon/uninstall';

// `korn uninstall`: which command removes the package, and what it cleans up

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

eq('npm', removeCommand('/opt/homebrew/lib/node_modules/korn-sync/korn.js'), 'npm uninstall -g korn-sync');
eq('npm (nvm)', removeCommand('/Users/me/.nvm/versions/node/v22.1.0/lib/node_modules/korn-sync/korn.js'), 'npm uninstall -g korn-sync');
eq('pnpm', removeCommand('/Users/me/Library/pnpm/global/5/node_modules/korn-sync/korn.js'), 'pnpm remove -g korn-sync');
eq('yarn', removeCommand('/Users/me/.config/yarn/global/node_modules/korn-sync/korn.js'), 'yarn global remove korn-sync');
eq('bun', removeCommand('/Users/me/.bun/install/global/node_modules/korn-sync/korn.js'), 'bun remove -g korn-sync');
eq('brew', removeCommand('/opt/homebrew/Cellar/korn/0.1.0/libexec/korn.js'), 'brew uninstall korn');
eq('VS Code copy', removeCommand('/Users/me/.vscode/extensions/midnightzkkornz.korn-extension-0.1.1/out/korn.js'), undefined);
eq('dev build', removeCommand('/Users/me/korn-extension/dist/korn.js'), undefined);

// end to end in a sandbox (service in dry-run: nothing goes to launchd)
execFileSync('node', ['daemon/build.mjs'], { stdio: 'pipe' });
const dir = mkdtempSync(join(tmpdir(), 'korn-uninstall-'));
const env = {
	...process.env,
	KORN_CONFIG: join(dir, 'config', 'config.yaml'),
	KORN_STATE_DIR: join(dir, 'state'),
	KORN_INSTALL_DIR: join(dir, 'share'),
	KORN_SERVICE_DIR: join(dir, 'agents'),
	KORN_SERVICE_DRYRUN: '1',
};
const korn = (...args: string[]) => execFileSync('node', ['dist/korn.js', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const repo = join(dir, 'notes');
mkdirSync(repo);
execFileSync('git', ['init', '-q'], { cwd: repo });
writeFileSync(join(repo, '.git', 'korn-paused.json'), '{}');
korn('add', repo);
korn('start');
mkdirSync(join(dir, 'state'), { recursive: true });
writeFileSync(join(dir, 'state', 'korn.log'), 'x\n');
eq('before: service + copy + config', [existsSync(join(dir, 'agents')), existsSync(join(dir, 'share', 'korn.js')), existsSync(env.KORN_CONFIG)], [true, true, true]);

let out = korn('uninstall'); // not a terminal → keeps settings
eq('keeps settings by default', [existsSync(env.KORN_CONFIG), existsSync(join(dir, 'state', 'korn.log')), existsSync(join(dir, 'share'))], [true, true, false]);
eq('service removed', existsSync(join(dir, 'agents', 'com.midnightzkkornz.korn.plist')) || existsSync(join(dir, 'agents', 'korn.service')), false);
eq('says how to remove the dev build', out.includes('VS Code'), true);

korn('start');
out = korn('uninstall', '--all');
eq('--all removes settings, logs, paused files', [existsSync(env.KORN_CONFIG), existsSync(join(dir, 'state')), existsSync(join(repo, '.git', 'korn-paused.json'))], [false, false, false]);
eq('notes untouched', existsSync(join(repo, '.git')), true);
eq('reports it', out.includes('ลบการตั้งค่าและ log แล้ว'), true);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
