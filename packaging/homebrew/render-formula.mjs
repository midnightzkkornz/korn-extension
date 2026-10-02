// node packaging/homebrew/render-formula.mjs <version> <sha256>  → prints Formula/korn.rb
// Used by the release workflow (.github/workflows/korn-release.yml) and `make daemon-release`.
import { readFileSync } from 'node:fs';

const [version, sha256] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[0-9a-f]{64}$/.test(sha256 ?? '')) {
	console.error('usage: render-formula.mjs <version x.y.z> <sha256>');
	process.exit(2);
}
const template = readFileSync(new URL('./korn.rb', import.meta.url), 'utf8');
const header = '# Generated from korn-extension/packaging/homebrew/korn.rb by the korn-release workflow: edit it there.\n';
process.stdout.write(
	header + template.replace(/^(#.*\n)+/, '').replaceAll('{{version}}', version).replaceAll('{{sha256}}', sha256)
);
