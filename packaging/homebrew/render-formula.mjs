// node packaging/homebrew/render-formula.mjs <version> <sha256>  → prints Formula/korn.rb
// Prints the formula (redirect it to Formula/korn.rb). Used by the release workflow and `make brew-formula`.
import { readFileSync } from 'node:fs';

const [version, sha256] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
	console.error('usage: render-formula.mjs <version x.y.z> <sha256>');
	process.exit(2);
}
const template = readFileSync(new URL('./korn.rb', import.meta.url), 'utf8');
const header = '# Generated from packaging/homebrew/korn.rb by packaging/homebrew/render-formula.mjs: edit it there, not here.\n';
process.stdout.write(
	header + template.replace(/^(#.*\n)+/, '').replaceAll('{{version}}', version).replaceAll('{{sha256}}', sha256)
);
