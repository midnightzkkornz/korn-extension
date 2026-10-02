// node packaging/npm/build.mjs → dist/npm/: the korn-sync package (npm, pnpm, yarn, bun and the Homebrew formula use it)
// Needs dist/korn.js (npm run daemon:build). Publish with `make npm-publish` or the korn-release workflow.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const version = readFileSync('daemon/version.ts', 'utf8').match(/'(.+)'/)[1];
const out = 'dist/npm';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const script = readFileSync('dist/korn.js', 'utf8');
if (!script.startsWith('#!/usr/bin/env node')) {
	throw new Error('dist/korn.js has no "#!/usr/bin/env node" line (see daemon/build.mjs)');
}
writeFileSync(`${out}/korn.js`, script);
chmodSync(`${out}/korn.js`, 0o755);
writeFileSync(`${out}/package.json`, readFileSync('packaging/npm/package.template.json', 'utf8').replace('{{version}}', version));
copyFileSync('packaging/npm/README.md', `${out}/README.md`);
copyFileSync('LICENSE', `${out}/LICENSE`);
console.log(`${out}: korn-sync@${version}`);
