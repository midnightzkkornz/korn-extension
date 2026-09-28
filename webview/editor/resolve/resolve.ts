import {
	applyChoice,
	buildResult,
	Choice,
	conflictsKey,
	hasConflictMarkers,
	parseConflicts,
	Segment,
	threeWayDiff,
	ThreeWayPart,
	wordDiff,
} from './conflictParser';

type Conflict = Extract<Segment, { kind: 'conflict' }>;

export interface ResolveHost {
	postMessage(message: unknown): void;
	loadChoices(key: string): (Choice | undefined)[] | undefined;
	saveChoices(key: string, choices: (Choice | undefined)[]): void;
}

const CHOICE_LABELS: Record<Exclude<Choice['type'], 'edit'>, string> = {
	mine: 'Used mine',
	theirs: 'Used theirs',
	mineFirst: 'Used both (mine first)',
	theirsFirst: 'Used both (theirs first)',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

// Friendlier names for git's marker labels
function sideName(label: string, fallback: string): string {
	return !label || label === 'HEAD' || label === '@{upstream}' ? fallback : label;
}

function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
	const b = el('button', className, label);
	b.addEventListener('click', onClick);
	return b;
}

// "⚠ Resolve" mode of the Korn editor: pick mine / theirs / both / edit for each conflict
export class ResolveView {
	private segments: Segment[] = [];
	private conflicts: Conflict[] = [];
	private choices: (Choice | undefined)[] = [];
	private key = '';
	private editing = -1;
	private rendered = new Set<number>(); // conflicts shown as rendered markdown instead of raw
	private renderRequest = 0;
	private readonly htmlCache = new Map<string, string>();

	constructor(
		private readonly root: HTMLElement,
		private readonly host: ResolveHost
	) {}

	/** Re-parse the document. Returns 'none' | 'conflicts' | 'malformed'. */
	update(text: string): 'none' | 'conflicts' | 'malformed' {
		const segments = parseConflicts(text);
		if (segments === null) {
			this.renderMalformed();
			return 'malformed';
		}
		if (segments.length === 0) {
			this.segments = [];
			this.conflicts = [];
			return hasConflictMarkers(text) ? 'malformed' : 'none';
		}

		const key = conflictsKey(segments);
		if (key !== this.key) {
			this.key = key;
			this.editing = -1;
			this.rendered.clear();
			this.choices = this.host.loadChoices(key) ?? [];
		}
		this.segments = segments;
		this.conflicts = segments.filter((s): s is Conflict => s.kind === 'conflict');
		this.render();
		return 'conflicts';
	}

	/** Reply from the extension with markdown rendered by VS Code */
	onRendered(requestId: number, texts: string[], htmls: string[]) {
		texts.forEach((t, i) => this.htmlCache.set(t, htmls[i]));
		if (requestId === this.renderRequest) {
			this.fillRendered();
		}
	}

	private setChoice(index: number, choice: Choice | undefined) {
		this.choices[index] = choice;
		this.editing = -1;
		this.host.saveChoices(this.key, this.choices);
		this.render();
	}

	private get resolvedCount(): number {
		return this.conflicts.filter((_, i) => this.choices[i]).length;
	}

	private render() {
		this.root.replaceChildren();
		const pending: string[] = []; // markdown to render through the extension

		// Header: progress + Finish & Sync
		const header = el('div', 'resolve-header');
		const done = this.resolvedCount === this.conflicts.length;
		header.append(
			el('span', 'resolve-progress', `${this.resolvedCount} / ${this.conflicts.length} conflicts resolved`),
			el('span', 'spacer')
		);
		const cancel = button(
			'Cancel — เลือกวิธีอื่น',
			() => {
				this.host.saveChoices(this.key, []); // forget the picks made here
				this.host.postMessage({ type: 'cancelResolve' });
			},
			'link'
		);
		const openText = button('Open in VS Code editor', () => this.host.postMessage({ type: 'openTextEditor' }), 'link');
		const finish = button('✓ Finish & Sync', () => this.finish(), 'primary');
		finish.disabled = !done;
		finish.title = done ? 'Write the result, conclude the merge and push' : 'Resolve every conflict first';
		header.append(cancel, openText, finish);
		this.root.append(header);

		const body = el('div', 'resolve-body');
		let conflictIndex = 0;
		for (const segment of this.segments) {
			if (segment.kind === 'text') {
				body.append(el('pre', 'resolve-context', segment.text));
			} else {
				body.append(this.renderConflict(segment, conflictIndex, pending));
				conflictIndex++;
			}
		}

		// Result preview (rendered)
		const result = buildResult(this.segments, this.choices);
		const preview = el('div', 'resolve-result');
		preview.append(el('div', 'resolve-result-title', done ? 'Result preview' : 'Result preview (unresolved parts still show both sides)'));
		const previewBody = el('div', 'resolve-rendered');
		previewBody.dataset.md = result;
		preview.append(previewBody);
		pending.push(result);
		body.append(preview);

		this.root.append(body);
		this.requestRender(pending);
	}

	private renderConflict(conflict: Conflict, index: number, pending: string[]): HTMLElement {
		const card = el('div', 'conflict-card');
		const choice = this.choices[index];

		const title = el('div', 'conflict-title');
		title.append(el('span', '', `Conflict ${index + 1} of ${this.conflicts.length}`));

		if (choice && this.editing !== index) {
			// Resolved: collapse to one line with the result
			card.classList.add('resolved');
			const label = choice.type === 'edit' ? 'Edited' : CHOICE_LABELS[choice.type];
			title.append(el('span', 'conflict-done', `✓ ${label}`), el('span', 'spacer'));
			title.append(button('Undo', () => this.setChoice(index, undefined), 'small'));
			card.append(title, el('pre', 'conflict-resolved-text', applyChoice(conflict, choice) || '(empty)'));
			return card;
		}

		title.append(el('span', 'spacer'));
		const showRendered = this.rendered.has(index);
		title.append(
			button(showRendered ? 'Raw' : 'Rendered', () => {
				if (showRendered) {
					this.rendered.delete(index);
				} else {
					this.rendered.add(index);
				}
				this.render();
			}, 'small')
		);
		card.append(title, this.legend(conflict.base !== undefined));

		// Mine | Theirs side by side. With the original (diff3) each side is compared to it,
		// so real conflicts (both changed the same place) stand out from one-sided changes.
		const sides = el('div', 'conflict-sides');
		const diff: { mine: ThreeWayPart[]; theirs: ThreeWayPart[] } =
			conflict.base !== undefined
				? threeWayDiff(conflict.base, conflict.mine, conflict.theirs)
				: (() => {
						const d = wordDiff(conflict.mine, conflict.theirs);
						const toParts = (parts: typeof d.mine) =>
							parts.map((p): ThreeWayPart => ({ text: p.text, kind: p.changed ? 'change' : 'same' }));
						return { mine: toParts(d.mine), theirs: toParts(d.theirs) };
					})();
		for (const side of ['mine', 'theirs'] as const) {
			const column = el('div', `conflict-side ${side}`);
			const label = side === 'mine' ? `Mine (${sideName(conflict.mineLabel, 'local')})` : `Theirs (${sideName(conflict.theirsLabel, 'remote')})`;
			column.append(el('div', 'conflict-side-label', label));
			const text = conflict[side];
			if (showRendered) {
				const box = el('div', 'resolve-rendered');
				box.dataset.md = text;
				pending.push(text);
				column.append(box);
			} else {
				// Word diff: highlight what this side has and the other doesn't
				const pre = el('pre', 'conflict-text');
				for (const part of diff[side]) {
					switch (part.kind) {
						case 'same':
							pre.append(document.createTextNode(part.text));
							break;
						case 'conflict':
							pre.append(el('mark', 'hl-conflict', part.text));
							break;
						case 'change':
							pre.append(el('mark', 'hl-change', part.text));
							break;
						case 'deleted':
							pre.append(el('del', '', part.text));
							break;
						case 'deletedConflict':
							pre.append(el('del', 'hl-conflict', part.text));
							break;
					}
				}
				if (!text) {
					pre.append(el('span', 'muted', '(empty)'));
				}
				column.append(pre);
			}
			sides.append(column);
		}
		card.append(sides);

		if (conflict.base !== undefined) {
			const details = el('details', 'conflict-base');
			details.append(el('summary', '', 'Original (before both changes)'), el('pre', 'conflict-text', conflict.base || '(empty)'));
			card.append(details);
		}

		if (this.editing === index) {
			const area = el('textarea', 'conflict-edit');
			area.value = choice?.type === 'edit' ? choice.text : conflict.mine + conflict.theirs;
			area.rows = Math.min(12, Math.max(3, area.value.split('\n').length + 1));
			const actions = el('div', 'conflict-actions');
			actions.append(
				button('Use this text', () => this.setChoice(index, { type: 'edit', text: area.value }), 'primary'),
				button('Cancel', () => {
					this.editing = -1;
					this.render();
				})
			);
			card.append(area, actions);
			queueMicrotask(() => area.focus());
		} else {
			const actions = el('div', 'conflict-actions');
			actions.append(
				button('Use mine', () => this.setChoice(index, { type: 'mine' }), 'primary'),
				button('Use theirs', () => this.setChoice(index, { type: 'theirs' }), 'primary'),
				button('Both: mine first', () => this.setChoice(index, { type: 'mineFirst' })),
				button('Both: theirs first', () => this.setChoice(index, { type: 'theirsFirst' })),
				button('Edit…', () => {
					this.editing = index;
					this.render();
				})
			);
			card.append(actions);
		}
		return card;
	}

	private legend(hasBase: boolean): HTMLElement {
		const legend = el('div', 'conflict-legend');
		if (!hasBase) {
			legend.append(el('mark', 'hl-change', 'ต่างกัน'), el('span', '', ' ไม่มี Original เลยไฮไลต์เฉพาะส่วนที่สองฝั่งต่างกัน'));
			return legend;
		}
		legend.append(
			el('mark', 'hl-conflict', 'ชนกัน'),
			el('span', '', ' ทั้งสองฝั่งแก้ตรงเดียวกัน'),
			el('mark', 'hl-change mine', 'เราแก้/เพิ่ม'),
			el('mark', 'hl-change theirs', 'อีกฝั่งแก้/เพิ่ม'),
			el('span', '', ' ฝั่งเดียว ไม่ชนกัน'),
			el('del', '', 'ลบ'),
			el('span', '', ' ข้อความเดิมที่ถูกลบ')
		);
		return legend;
	}

	private requestRender(texts: string[]) {
		const missing = [...new Set(texts)].filter((t) => !this.htmlCache.has(t));
		this.renderRequest++;
		if (missing.length === 0) {
			this.fillRendered();
		} else {
			this.fillRendered();
			this.host.postMessage({ type: 'renderMany', requestId: this.renderRequest, texts: missing });
		}
	}

	private fillRendered() {
		for (const box of this.root.querySelectorAll<HTMLElement>('.resolve-rendered')) {
			const html = this.htmlCache.get(box.dataset.md ?? '');
			if (html !== undefined) {
				box.innerHTML = html;
			}
		}
	}

	private finish() {
		this.host.postMessage({ type: 'finishResolve', text: buildResult(this.segments, this.choices) });
	}

	private renderMalformed() {
		this.root.replaceChildren();
		const box = el('div', 'resolve-malformed');
		box.append(
			el('p', '', 'แยก conflict ในไฟล์นี้ไม่ได้ (marker <<<<<<< / ======= / >>>>>>> ไม่ครบหรือซ้อนกัน)'),
			button('Open in VS Code editor', () => this.host.postMessage({ type: 'openTextEditor' }), 'primary')
		);
		this.root.append(box);
	}
}
