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
import type { Choice } from './resolve/conflictParser';
import { ResolveView } from './resolve/resolve';

type Mode = 'view' | 'text' | 'preview' | 'editor' | 'resolve';
const MODES: Mode[] = ['view', 'text', 'preview', 'editor', 'resolve'];

// Messages from the extension
// ackSeq = the last of our edits that is already in the VS Code document
type HostMessage =
	| { type: 'init' | 'update'; text: string; html: string; ackSeq: number }
	| { type: 'syncState'; state: SyncState; time?: string }
	| { type: 'renderedMany'; requestId: number; texts: string[]; htmls: string[] };

// conflict = found, nothing chosen yet · resolving = "Resolve in Korn" chosen · merging = resolved, ready to push
type SyncState = 'syncing' | 'done' | 'error' | 'idle' | 'conflict' | 'resolving' | 'merging';

// Per-tab state that survives reloads
interface WebviewState {
	mode?: Mode;
	resolve?: { key: string; choices: (Choice | undefined)[] };
}

declare function acquireVsCodeApi(): {
	postMessage(message: unknown): void;
	getState(): WebviewState | undefined;
	setState(state: WebviewState): void;
};

const vscode = acquireVsCodeApi();
function saveState(patch: WebviewState) {
	vscode.setState({ ...vscode.getState(), ...patch });
}
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
function flushEdit() {
	if (editTimer !== undefined) {
		clearTimeout(editTimer);
		editTimer = undefined;
		vscode.postMessage({ type: 'edit', text: currentText, seq: localSeq });
	}
}
function onLocalEdit(text: string) {
	if (text === currentText) {
		return;
	}
	currentText = text;
	localSeq++;
	clearTimeout(editTimer);
	editTimer = setTimeout(flushEdit, 150);
	refreshResolve();
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

// ---- Resolve mode: our own conflict resolver (webview/resolve.ts) ----
const resolveTab = document.querySelector<HTMLButtonElement>('.nav button[data-mode="resolve"]')!;
const resolveView = new ResolveView(document.getElementById('resolve')!, {
	postMessage: (message) => vscode.postMessage(message),
	loadChoices: (key) => (vscode.getState()?.resolve?.key === key ? vscode.getState()?.resolve?.choices : undefined),
	saveChoices: (key, choices) => saveState({ resolve: { key, choices } }),
});
let hadConflicts = false;

// Show the Resolve tab only while the file has conflicts, and jump to it when they appear
function refreshResolve() {
	const status = resolveView.update(currentText);
	const hasConflicts = status !== 'none';
	resolveTab.hidden = !hasConflicts;
	if (hasConflicts && !hadConflicts && mode !== 'resolve') {
		setMode('resolve');
	} else if (!hasConflicts && mode === 'resolve') {
		setMode('view');
	}
	hadConflicts = hasConflicts;
}

// ---- Mode switching ----
function setMode(next: Mode) {
	mode = next;
	saveState({ mode });
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
const syncButton = document.getElementById('sync') as HTMLButtonElement;
syncButton.addEventListener('click', () => {
	flushEdit(); // send the latest text before syncing
	vscode.postMessage({ type: 'sync' });
});

// ---- Sync status in the toolbar ----
const statusEl = document.getElementById('status')!;
// "Conflict — เลือกวิธีจัดการ" is clickable: shows the choices again after pressing Esc
statusEl.addEventListener('click', () => {
	if (statusEl.dataset.state === 'conflict') {
		vscode.postMessage({ type: 'reopenConflict' });
	}
});
const statusText = document.getElementById('status-text')!;
let lastSyncLabel = 'Last sync: never';

function setSyncState(state: SyncState, time?: string) {
	statusEl.dataset.state = state;
	syncButton.disabled = state === 'syncing';
	if (state === 'done' && time) {
		const date = new Date(time);
		const pad = (n: number) => String(n).padStart(2, '0');
		// Same format as the commit message: YYYY-MM-DD HH:mm
		lastSyncLabel = `Last sync: ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
	const labels: Partial<Record<SyncState, string>> = {
		syncing: 'Syncing…',
		error: 'Sync failed',
		conflict: 'Conflict — เลือกวิธีจัดการ',
		resolving: 'Conflict — เลือกในแท็บ Resolve แล้วกด Finish & Sync',
		merging: 'Merge ready — กด Sync เพื่อ push',
	};
	statusText.textContent = labels[state] ?? lastSyncLabel;
}

// ---- Messages from the extension ----
window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	if (message.type === 'syncState') {
		setSyncState(message.state, message.time);
		return;
	}
	if (message.type === 'renderedMany') {
		resolveView.onRendered(message.requestId, message.texts, message.htmls);
		return;
	}
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
		// a reload in Resolve mode keeps it; otherwise refreshResolve() decides
		hadConflicts = mode === 'resolve';
		setMode(mode);
	}
	refreshResolve();
});

vscode.postMessage({ type: 'ready' });
