import { markdown } from '@codemirror/lang-markdown';
import { Annotation } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { Editor, editorViewCtx, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { replaceAll } from '@milkdown/kit/utils';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import './style.css';

type Mode = 'korn' | 'text' | 'preview' | 'editor';

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
let mode: Mode = vscode.getState()?.mode ?? 'korn';

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
const External = Annotation.define<boolean>();
const codeMirror = new EditorView({
	parent: textPane,
	extensions: [
		basicSetup,
		markdown(),
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
