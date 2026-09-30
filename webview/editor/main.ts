import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Annotation } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { styleTags, Tag, tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { Editor, editorViewCtx, remarkStringifyOptionsCtx, rootCtx, defaultValueCtx } from '@milkdown/kit/core';
import { history } from '@milkdown/kit/plugin/history';
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import './style.css';
import type { Choice } from './resolve/conflictParser';
import { ResolveView } from './resolve/resolve';
import { preferredBullet, preserveFormatting } from './preserveFormatting';

type Mode = 'view' | 'text' | 'preview' | 'editor' | 'resolve';
const MODES: Mode[] = ['view', 'text', 'preview', 'editor', 'resolve'];

// Messages from the extension
// ackSeq = the last of our edits that is already in the VS Code document
type HostMessage =
	| { type: 'init' | 'update'; text: string; html: string; ackSeq: number }
	| { type: 'syncState'; state: SyncState; time?: string }
	| { type: 'syncTarget'; title: string } // "Sync ไป origin/main" (Sync button tooltip)
	| { type: 'setMode'; mode: Mode | 'next' } // keyboard shortcuts (src/commands/shortcuts.ts)
	| { type: 'insertText'; text: string }
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
// Milkdown writes markdown in its own style; preserveFormatting() keeps the file's original
// text everywhere the user didn't edit (see webview/editor/preserveFormatting.ts).
let milkdown: Editor | undefined;
let milkdownSource = ''; // the document text Milkdown currently shows
let milkdownOriginal = ''; // the file text when it was loaded into Milkdown
let milkdownBaseline = ''; // Milkdown's own markdown for milkdownOriginal, before any edit

async function showMilkdown(text: string) {
	if (!milkdown) {
		milkdownSource = milkdownOriginal = text;
		milkdown = await Editor.make()
			.config((ctx) => {
				ctx.set(rootCtx, wysiwygPane);
				ctx.set(defaultValueCtx, text);
				// write lists with the file's bullet ("*" or "-")
				ctx.update(remarkStringifyOptionsCtx, (options) => ({ ...options, bullet: preferredBullet(text) }));
				ctx.get(listenerCtx).markdownUpdated((ctx, md) => {
					// Only forward changes the user typed, not our own replaceAll()
					if (ctx.get(editorViewCtx).hasFocus()) {
						milkdownSource = preserveFormatting(milkdownOriginal, milkdownBaseline, md);
						onLocalEdit(milkdownSource);
					}
				});
			})
			.use(commonmark)
			.use(gfm)
			.use(history)
			.use(listener)
			.create();
		milkdownBaseline = milkdown.action(getMarkdown());
	} else if (text !== milkdownSource) {
		milkdownSource = milkdownOriginal = text;
		milkdown.action(replaceAll(text));
		milkdownBaseline = milkdown.action(getMarkdown());
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

// ---- Keyboard shortcuts (sent by the extension) ----
const CYCLE: Mode[] = ['view', 'text', 'preview', 'editor'];
function showModeFromShortcut(next: Mode | 'next') {
	if (next === 'next') {
		next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length]; // from Resolve: back to View
	}
	if (MODES.includes(next) && (next !== 'resolve' || !resolveTab.hidden)) {
		setMode(next);
	}
}

// Type text at the cursor of the Text / Preview / Editor pane (View and Resolve have no cursor)
function insertAtCursor(text: string) {
	if (mode === 'text' || mode === 'preview') {
		codeMirror.dispatch(codeMirror.state.replaceSelection(text));
		codeMirror.focus();
	} else if (mode === 'editor' && milkdown) {
		milkdown.action((ctx) => {
			const view = ctx.get(editorViewCtx);
			view.focus(); // markdownUpdated only forwards edits while the editor has focus
			view.dispatch(view.state.tr.insertText(text));
		});
	}
}

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
	if (message.type === 'syncTarget') {
		syncButton.title = message.title;
		return;
	}
	if (message.type === 'setMode') {
		showModeFromShortcut(message.mode);
		return;
	}
	if (message.type === 'insertText') {
		insertAtCursor(message.text);
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

// Resolve tab: keys to pick mine / theirs / both without the mouse (see ResolveView.handleKey)
document.addEventListener('keydown', (event) => {
	if (mode === 'resolve' && resolveView.handleKey(event)) {
		event.preventDefault();
	}
});

// <base href> points at the file's folder (for relative images), which would also turn
// "#heading" links into links to that folder: scroll to the heading on this page instead
document.addEventListener('click', (event) => {
	const link = (event.target as Element | null)?.closest?.('a');
	const href = link?.getAttribute('href');
	if (!href?.startsWith('#')) {
		return;
	}
	event.preventDefault();
	const id = decodeURIComponent(href.slice(1));
	const pane = document.querySelector(`#${CSS.escape(mode === 'editor' ? 'wysiwyg' : 'rendered')}`) ?? document;
	(pane.querySelector(`[id="${CSS.escape(id)}"]`) ?? document.getElementById(id))?.scrollIntoView({ block: 'start' });
});

vscode.postMessage({ type: 'ready' });
