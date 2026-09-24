import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';

// `import css from 'x.css?raw'` → the file's contents as a string (used for the GitHub themes)
const rawPlugin = {
	name: 'raw',
	setup(build) {
		build.onResolve({ filter: /\?raw$/ }, async (args) => {
			const result = await build.resolve(args.path.slice(0, -'?raw'.length), {
				kind: args.kind,
				resolveDir: args.resolveDir,
			});
			return { path: result.path, namespace: 'raw' };
		});
		build.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
			contents: await readFile(args.path, 'utf8'),
			loader: 'text',
		}));
	},
};

// Bundles the webview UI (CodeMirror + Milkdown) into out/webview.js + out/webview.css
const options = {
	entryPoints: ['webview/main.ts'],
	bundle: true,
	format: 'iife',
	target: 'es2022',
	outfile: 'out/webview.js',
	minify: !process.argv.includes('--watch'),
	sourcemap: process.argv.includes('--watch'),
	logLevel: 'info',
	plugins: [rawPlugin],
};

if (process.argv.includes('--watch')) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
