import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Annotation } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { styleTags, Tag, tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { Editor, editorViewCtx, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { replaceAll } from '@milkdown/kit/utils';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import './style.css';

type Mode = 'view' | 'text' | 'preview' | 'editor';
const MODES: Mode[] = ['view', 'text', 'preview', 'editor'];

// Messages from the extension
// ackSeq = the last of our edits that is already in the VS Code document
type HostMessage = { type: 'init' | 'update'; text: string; html: string; ackSeq: number };

declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
	getState(): { mode?: Mode } | undefined;
	setState(state: { mode: Mode }): void;
};

const vscode = acquireVsCodeApi();
const rendered = document.getElementById('rendered')!;
const textPane = document.getElementById('text')!;
const wysiwygPane = document.getElementById('wysiwyg')!;

// Latest markdown known to this webview (kept in sync with the VS Code document)
let currentText = '';
const savedMode = vscode.getState()?.mode;
let mode: Mode = savedMode && MODES.includes(savedMode) ? savedMode : 'view';

// ---- Sending edits back to VS Code (debounced) ----
let editTimer: ReturnType<typeof setTimeout> | undefined;
let localSeq = 0;
function onLocalEdit(text: string) {
	if (text === currentText) {
		return;
	}
	currentText = text;
	localSeq++;
	clearTimeout(editTimer);
	editTimer = setTimeout(() => vscode.postMessage({ type: 'edit', text: currentText, seq: localSeq }), 150);
}

// ---- Text + Preview modes: CodeMirror ----
// Token classes are colored like VS Code's Dark+/Light+ markdown in style.css
// (replaces CodeMirror's default style, which underlines headings)
const listMark = Tag.define();
const markdownHighlight = HighlightStyle.define([
	{ tag: tags.heading, class: 'tok-heading' },
	{ tag: tags.strong, class: 'tok-strong' },
	{ tag: tags.emphasis, class: 'tok-emphasis' },
	{ tag: tags.strikethrough, class: 'tok-strike' },
	{ tag: tags.monospace, class: 'tok-code' },
	{ tag: tags.quote, class: 'tok-quote' },
	{ tag: listMark, class: 'tok-list' },
	// Code inside fenced blocks
	{ tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.bool, tags.null], class: 'tok-keyword' },
	{ tag: [tags.string, tags.regexp], class: 'tok-string' },
	{ tag: tags.comment, class: 'tok-comment' },
	{ tag: tags.number, class: 'tok-number' },
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: 'tok-function' },
	{ tag: [tags.className, tags.typeName, tags.namespace], class: 'tok-type' },
	{ tag: [tags.variableName, tags.propertyName, tags.definition(tags.variableName)], class: 'tok-variable' },
	{ tag: tags.tagName, class: 'tok-tag' },
	{ tag: tags.attributeName, class: 'tok-attr' },
]);

const External = Annotation.define<boolean>();
const codeMirror = new EditorView({
	parent: textPane,
	extensions: [
		basicSetup,
		// ListMark ("-", "1.") gets its own tag so it can be colored like VS Code
		markdown({ extensions: { props: [styleTags({ 'ListItem/ListMark': listMark })] } }),
		syntaxHighlighting(markdownHighlight),
		EditorView.lineWrapping,
		EditorView.theme({
			'&': { height: '100%' },
			'.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family)' },
		}),
		EditorView.updateListener.of((update) => {
			const external = update.transactions.some((tr) => tr.annotation(External));
			if (update.docChanged && !external) {
				onLocalEdit(update.state.doc.toString());
			}
		}),
	],
});

function setCodeMirrorText(text: string) {
	if (codeMirror.state.doc.toString() !== text) {
		codeMirror.dispatch({
			changes: { from: 0, to: codeMirror.state.doc.length, insert: text },
			annotations: External.of(true),
		});
	}
}

// ---- Editor mode: Milkdown WYSIWYG (created on first use) ----
let milkdown: Editor | undefined;
let milkdownText = '';

async function showMilkdown(text: string) {
	if (!milkdown) {
		milkdownText = text;
		milkdown = await Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, wysiwygPane);
				ctx.set(defaultValueCtx, text);
				ctx.get(listenerCtx).markdownUpdated((ctx, md) => {
					// Only forward changes the user typed, not our own replaceAll()
					if (ctx.get(editorViewCtx).hasFocus()) {
						milkdownText = md;
						onLocalEdit(md);
					}
				});
			})
			.use(commonmark)
			.use(gfm)
			.use(history)
			.use(listener)
			.create();
	} else if (text !== milkdownText) {
		milkdownText = text;
		milkdown.action(replaceAll(text));
	}
}

// ---- Mode switching ----
function setMode(next: Mode) {
	mode = next;
	vscode.setState({ mode });
	document.body.dataset.mode = mode;
	for (const button of document.querySelectorAll<HTMLButtonElement>('.nav button')) {
		button.classList.toggle('active', button.dataset.mode === mode);
	}

	if (mode === 'text' || mode === 'preview') {
		setCodeMirrorText(currentText);
		codeMirror.requestMeasure();
		codeMirror.focus();
	} else if (mode === 'editor') {
		showMilkdown(currentText);
	}
}

for (const button of document.querySelectorAll<HTMLButtonElement>('.nav button')) {
	button.addEventListener('click', () => setMode(button.dataset.mode as Mode));
}
document.getElementById('sync')!.addEventListener('click', () => vscode.postMessage({ type: 'sync' }));

// ---- Messages from the extension ----
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	rendered.innerHTML = message.html;

	// Take the document text only when all our own edits are in it (otherwise it's stale)
	if (message.ackSeq === localSeq && message.text !== currentText) {
		currentText = message.text;
		setCodeMirrorText(currentText);
		if (mode === 'editor') {
			showMilkdown(currentText);
		}
	}
	if (message.type === 'init') {
		setMode(mode);
	}
});

vscode.postMessage({ type: 'ready' });
