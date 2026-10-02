import { copyFileSync, mkdirSync } from 'fs';
import * as esbuild from 'esbuild';

// Bundles the korn CLI/daemon into one file (node, no node_modules needed):
// - dist/korn.js: for the Homebrew tarball (make daemon-release)
// - out/korn.js:  shipped inside the VS Code extension, which runs it for "background sync"
await esbuild.build({
	entryPoints: ['daemon/cli.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	outfile: 'dist/korn.js',
	banner: { js: '#!/usr/bin/env node' },
	logLevel: 'info',
});
mkdirSync('out', { recursive: true });
copyFileSync('dist/korn.js', 'out/korn.js');
