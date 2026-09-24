import * as esbuild from 'esbuild';

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
};

if (process.argv.includes('--watch')) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
