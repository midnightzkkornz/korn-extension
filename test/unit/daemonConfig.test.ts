import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { addRepo, ConfigError, initConfig, isIncluded, parseConfig, removeRepo, settingsFor } from '../../daemon/config';

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
const error = (text: string): string => {
	try {
		parseConfig(text);
		return 'no error';
	} catch (e) {
		return e instanceof ConfigError ? e.message : `other: ${e}`;
	}
};

// defaults
const c = parseConfig('repos:\n  - path: ~/notes\n');
eq('path: ~ expanded', c.repos[0].path, join(homedir(), 'notes'));
eq('defaults', [c.repos[0].include, c.repos[0].quietMinutes, c.repos[0].pullEveryMinutes, c.repos[0].conflict, c.notify], [['**/*.md'], 5, 10, 'saveCopy', 'auto']);
eq('notify values', ['banner', 'dialog', 'off', 'auto'].map((v) => parseConfig(`notify: ${v}\n`).notify), ['banner', 'dialog', 'off', 'auto']);
eq('notify true/false (older configs)', [parseConfig('notify: true\n').notify, parseConfig('notify: false\n').notify], ['auto', 'off']);
eq('bad notify', error('notify: loud\n'), 'line 1: notify: ต้องเป็น auto | banner | dialog | off');
eq('empty file = no repos', parseConfig('').repos, []);
eq('template is valid', parseConfig(readTemplate()).repos, []);

// errors name the field and line
eq('bad conflict', error('repos:\n  - path: /x\n    conflict: yes\n'), 'line 3: repos[0].conflict: ต้องเป็น saveCopy | keepMine | keepTheirs | pause | resolve');
eq('negative minutes', error('repos:\n  - path: /x\n    quietMinutes: -1\n'), 'line 3: repos[0].quietMinutes: ต้องเป็นตัวเลขนาทีตั้งแต่ 0 ขึ้นไป');
eq('missing path', error('repos:\n  - include: "*.md"\n'), 'line 2: repos[0].path: ต้องระบุ path ของ repo');
eq('unknown key (typo)', error('repos:\n  - path: /x\n    quietMinute: 3\n'), 'line 3: repos[0].quietMinute: ไม่รู้จัก (ใช้ได้: path, include, exclude, quietMinutes, pullEveryMinutes, conflict, rules)');
eq('bad rule', error('repos:\n  - path: /x\n    rules:\n      - conflict: pause\n'), 'line 4: repos[0].rules[0].match: ต้องระบุ match เช่น "journal/*.md"');
eq('yaml syntax error has a line', /^line \d+: /.test(error('repos:\n  - path: [\n')), true);

// include / exclude / rules
const r = parseConfig(`repos:
  - path: /x
    exclude: ["drafts/**"]
    conflict: pause
    rules:
      - match: "journal/*.md"
        conflict: keepMine
        quietMinutes: 0
`).repos[0];
eq('includes nested .md', isIncluded(r, 'a/b/c.md'), true);
eq('skips non-.md', isIncluded(r, 'a.txt'), false);
eq('skips excluded', isIncluded(r, 'drafts/x.md'), false);
eq('skips dot folders', isIncluded(r, '.obsidian/x.md'), false);
eq('rule wins', settingsFor(r, 'journal/today.md'), { conflict: 'keepMine', quietMinutes: 0 });
eq('repo setting otherwise', settingsFor(r, 'notes.md'), { conflict: 'pause', quietMinutes: 5 });

// init / add / remove keep the file valid and the comments
const dir = mkdtempSync(join(tmpdir(), 'korn-config-'));
const file = join(dir, 'config.yaml');
eq('init creates', initConfig(file), true);
eq('init again keeps', initConfig(file), false);
eq('add', addRepo('/tmp/notes', file), true);
eq('add twice', addRepo('/tmp/notes', file), false);
eq('added repo parsed', parseConfig(readFileSync(file, 'utf8')).repos.map((x) => x.path), ['/tmp/notes']);
eq('comments kept', readFileSync(file, 'utf8').includes('# Korn daemon'), true);
writeFileSync(file, readFileSync(file, 'utf8').replace('- path: /tmp/notes', '- path: /tmp/notes\n    conflict: keepMine'));
addRepo('/tmp/other', file);
eq('user settings kept on add', parseConfig(readFileSync(file, 'utf8')).repos.map((x) => [x.path, x.conflict]), [['/tmp/notes', 'keepMine'], ['/tmp/other', 'saveCopy']]);
eq('remove', removeRepo('/tmp/notes', file), true);
eq('removed', parseConfig(readFileSync(file, 'utf8')).repos.map((x) => x.path), ['/tmp/other']);
rmSync(dir, { recursive: true, force: true });

function readTemplate(): string {
	const d = mkdtempSync(join(tmpdir(), 'korn-template-'));
	initConfig(join(d, 'c.yaml'));
	const text = readFileSync(join(d, 'c.yaml'), 'utf8');
	rmSync(d, { recursive: true, force: true });
	return text;
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
