// npm test: bundle each test/**/*.test.ts with esbuild, run it with node, and sum up the results.
// unit/ = pure logic · git/ = real git repos in a temp folder (needs git installed)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import * as esbuild from 'esbuild';

const root = new URL('.', import.meta.url).pathname;
const files = ['unit', 'git'].flatMap((dir) =>
	readdirSync(join(root, dir))
		.filter((f) => f.endsWith('.test.ts'))
		.map((f) => join(root, dir, f))
);

const outDir = mkdtempSync(join(tmpdir(), 'korn-test-build-'));
let passed = 0;
let failed = 0;
const failures = [];

try {
	for (const file of files) {
		const name = relative(root, file);
		const outfile = join(outDir, name.replace(/[\\/]/g, '_') + '.cjs');
		await esbuild.build({ entryPoints: [file], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'error' });

		let output = '';
		let crashed = false;
		try {
			output = execFileSync(process.execPath, [outfile], { encoding: 'utf8' });
		} catch (error) {
			output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
			crashed = true;
		}
		const pass = (output.match(/^PASS /gm) ?? []).length;
		const fail = (output.match(/^FAIL /gm) ?? []).length;
		passed += pass;
		failed += fail;
		const ok = !crashed && fail === 0 && output.includes('ALL PASSED');
		console.log(`${ok ? '✓' : '✗'} ${name.padEnd(32)} ${pass} passed${fail ? `, ${fail} failed` : ''}`);
		if (!ok) {
			failures.push(`--- ${name}\n${output.split('\n').filter((l) => !l.startsWith('PASS ')).join('\n')}`);
		}
	}
} finally {
	rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
	console.log(`\n${failures.join('\n')}`);
	process.exit(1);
}
