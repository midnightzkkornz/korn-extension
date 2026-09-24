import markdownDark from 'github-markdown-css/github-markdown-dark.css?raw';
import markdownLight from 'github-markdown-css/github-markdown-light.css?raw';
import codeDark from 'highlight.js/styles/github-dark.css?raw';
import codeLight from 'highlight.js/styles/github.css?raw';

// GitHub markdown + code block styles, switched to follow the VS Code theme
const LIGHT = markdownLight + codeLight;
const DARK = markdownDark + codeDark;

function isLight(): boolean {
	const classes = document.body.classList;
	return classes.contains('vscode-light') || classes.contains('vscode-high-contrast-light');
}

export function watchTheme() {
	const style = document.createElement('style');
	document.head.appendChild(style);

	const apply = () => {
		const css = isLight() ? LIGHT : DARK;
		if (style.textContent !== css) {
			style.textContent = css;
		}
	};

	apply();
	// VS Code updates the body classes when the user switches theme
	new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
