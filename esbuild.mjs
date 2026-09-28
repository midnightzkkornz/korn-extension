import * as esbuild from 'esbuild';

// Bundles the webview UIs:
// - out/editor.js + .css: the Korn editor (CodeMirror + Milkdown)
// - out/panel.js + .css:   the Korn Sync side panel (Preact / TSX)
const options = {
	entryPoints: {
		editor: 'webview/editor/main.ts',
		panel: 'webview/panel/main.tsx',
	},
	bundle: true,
	format: 'iife',
	target: 'es2022',
	outdir: 'out',
	jsx: 'automatic',
	jsxImportSource: 'preact',
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
