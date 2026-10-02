import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigError, initConfig, parseConfig, setTopLevel } from '../../daemon/config';
import { nextStep } from '../../daemon/messages';
import { openMode, resolveCommandScript } from '../../daemon/opener';

// korn without VS Code: where conflicts open, the Terminal command, the Homebrew formula

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

// ---- open: auto | vscode | terminal ----
eq('auto + VS Code installed → vscode', openMode('auto', true), 'vscode');
eq('auto + no VS Code → terminal', openMode('auto', false), 'terminal');
eq('terminal even with VS Code', openMode('terminal', true), 'terminal');
eq('config default open = auto', parseConfig('').open, 'auto');
eq('config open: terminal', parseConfig('open: terminal\n').open, 'terminal');
let message = '';
try {
	parseConfig('open: zed\n');
} catch (e) {
	message = e instanceof ConfigError ? e.message : String(e);
}
eq('bad open value → line', message, 'line 1: open: ต้องเป็น auto | vscode | terminal');

const dir = mkdtempSync(join(tmpdir(), 'korn-term-'));
const file = join(dir, 'config.yaml');
initConfig(file);
setTopLevel('open', 'terminal', file);
eq('setTopLevel open', parseConfig(readFileSync(file, 'utf8')).open, 'terminal');
eq('  comments kept', readFileSync(file, 'utf8').includes('# Korn daemon'), true);

// ---- next step wording ----
eq('terminal: no VS Code mention', nextStep.ask('note.r.md', 'terminal'), 'พิมพ์: korn resolve note.r.md');
eq('vscode: both ways', nextStep.ask('note.r.md', 'vscode').startsWith('เลือกใน VS Code'), true);
eq('paused', nextStep.paused('a.md'), 'พิมพ์: korn resolve a.md');

// ---- the .command that "เลือกเลย" opens in Terminal ----
const script = resolveCommandScript("/Users/me/My Notes/it's", 'notes/note.r.md', '/opt/homebrew/bin/node', '/Users/me/.local/share/korn/korn.js');
eq('cd with spaces and quotes', script.includes(`cd '/Users/me/My Notes/it'\\''s' || exit 1`), true);
eq('runs korn resolve <file>', script.includes(`'/opt/homebrew/bin/node' '/Users/me/.local/share/korn/korn.js' resolve 'notes/note.r.md'`), true);
const commandFile = join(dir, 'resolve.command');
writeFileSync(commandFile, script);
let valid = true;
try {
	execFileSync('bash', ['-n', commandFile]); // syntax check only
} catch {
	valid = false;
}
eq('valid bash', valid, true);

// ---- Homebrew formula ----
const formula = execFileSync('node', ['packaging/homebrew/render-formula.mjs', '1.2.3', 'a'.repeat(64)], { encoding: 'utf8' });
eq('formula url', formula.includes('releases/download/korn-v1.2.3/korn-1.2.3.tar.gz"'), true);
eq('formula sha256', formula.includes(`sha256 "${'a'.repeat(64)}"`), true);
eq('no placeholders left', /\{\{/.test(formula), false);
eq('generated header', formula.startsWith('# Generated from korn-extension/packaging/homebrew/korn.rb'), true);
writeFileSync(join(dir, 'korn.rb'), formula);
let rubyOk = true;
try {
	execFileSync('ruby', ['-c', join(dir, 'korn.rb')], { stdio: 'pipe' });
} catch {
	rubyOk = false;
}
eq('formula is valid Ruby', rubyOk, true);
let rejected = false;
try {
	execFileSync('node', ['packaging/homebrew/render-formula.mjs', 'v1', 'x'], { stdio: 'pipe' });
} catch {
	rejected = true;
}
eq('bad arguments rejected', rejected, true);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
