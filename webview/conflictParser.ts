// Parses git conflict markers (with or without the diff3 "|||||||" base section).
// No DOM access, so it can be unit-tested with node.
import { diffWordsWithSpace } from 'diff';

export type Segment =
	| { kind: 'text'; text: string }
	| { kind: 'conflict'; mine: string; base?: string; theirs: string; mineLabel: string; theirsLabel: string };

export type Choice =
	| { type: 'mine' }
	| { type: 'theirs' }
	| { type: 'mineFirst' }
	| { type: 'theirsFirst' }
	| { type: 'edit'; text: string };

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SEP = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;

// Split keeping each line's own ending ("\n" or "\r\n")
function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function bare(line: string): string {
	return line.replace(/\r?\n$/, '');
}

export function hasConflictMarkers(text: string): boolean {
	return /^(<{7}|>{7})( |$)/m.test(text);
}

/**
 * Returns the segments, [] when there are no conflicts, or null when the markers are
 * malformed (e.g. a start marker without its end) and can't be resolved here.
 */
export function parseConflicts(text: string): Segment[] | null {
	const segments: Segment[] = [];
	let plain = '';
	let current: { mine: string; base?: string; theirs: string; mineLabel: string; theirsLabel: string } | undefined;
	let part: 'mine' | 'base' | 'theirs' = 'mine';

	for (const line of splitLines(text)) {
		const b = bare(line);

		if (!current) {
			const start = START.exec(b);
			if (start) {
				if (plain) {
					segments.push({ kind: 'text', text: plain });
					plain = '';
				}
				current = { mine: '', theirs: '', mineLabel: start[1] ?? '', theirsLabel: '' };
				part = 'mine';
			} else if (BASE.test(b) || SEP.test(b) || END.test(b)) {
				// A lone "=======" is valid markdown (setext heading underline); only stray <<< / ||| / >>> are errors
				if (SEP.test(b)) {
					plain += line;
				} else {
					return null;
				}
			} else {
				plain += line;
			}
			continue;
		}

		if (START.test(b)) {
			return null; // nested conflict
		}
		if (part === 'mine' && BASE.test(b)) {
			part = 'base';
			current.base = '';
		} else if ((part === 'mine' || part === 'base') && SEP.test(b)) {
			part = 'theirs';
		} else if (part === 'theirs' && END.test(b)) {
			current.theirsLabel = END.exec(b)?.[1] ?? '';
			segments.push({ kind: 'conflict', ...current });
			current = undefined;
		} else if (part === 'mine') {
			current.mine += line;
		} else if (part === 'base') {
			current.base += line;
		} else {
			current.theirs += line;
		}
	}

	if (current) {
		return null; // unterminated conflict
	}
	if (plain) {
		segments.push({ kind: 'text', text: plain });
	}
	return segments.some((s) => s.kind === 'conflict') ? segments : [];
}

function joinBlocks(first: string, second: string): string {
	if (first && second && !first.endsWith('\n')) {
		return `${first}\n${second}`;
	}
	return first + second;
}

export function applyChoice(segment: Extract<Segment, { kind: 'conflict' }>, choice: Choice): string {
	switch (choice.type) {
		case 'mine':
			return segment.mine;
		case 'theirs':
			return segment.theirs;
		case 'mineFirst':
			return joinBlocks(segment.mine, segment.theirs);
		case 'theirsFirst':
			return joinBlocks(segment.theirs, segment.mine);
		case 'edit': {
			// keep the block ending with a newline like the original, so the next line isn't glued on
			const needsNewline = (segment.mine.endsWith('\n') || segment.theirs.endsWith('\n')) && !choice.text.endsWith('\n');
			return needsNewline && choice.text ? `${choice.text}\n` : choice.text;
		}
	}
}

// Final file text. Conflicts without a choice keep their markers (so nothing is lost).
export function buildResult(segments: Segment[], choices: (Choice | undefined)[]): string {
	let conflictIndex = 0;
	let out = '';
	for (const segment of segments) {
		if (segment.kind === 'text') {
			out += segment.text;
			continue;
		}
		const choice = choices[conflictIndex++];
		out += choice ? applyChoice(segment, choice) : segment.mine + segment.theirs;
	}
	return out;
}

// Stable key for a set of conflicts, to know if saved choices still apply
export function conflictsKey(segments: Segment[]): string {
	let hash = 0;
	const text = segments.map((s) => (s.kind === 'conflict' ? `${s.mine}\u0000${s.theirs}` : '')).join('\u0001');
	for (let i = 0; i < text.length; i++) {
		hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
	}
	return String(hash);
}

export interface DiffPart {
	text: string;
	changed: boolean;
}

// Word diff for highlighting. Whitespace/newlines are separate tokens, so joining a side's
// parts gives back exactly its original text (diffWords would borrow the other side's whitespace).
export function wordDiff(mine: string, theirs: string): { mine: DiffPart[]; theirs: DiffPart[] } {
	const result = { mine: [] as DiffPart[], theirs: [] as DiffPart[] };
	const push = (parts: DiffPart[], text: string, changed: boolean) => {
		if (!changed) {
			parts.push({ text, changed: false });
			return;
		}
		// highlight only the words, not the spaces/newlines around them
		const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
		for (const [t, c] of [[lead, false], [core, true], [trail, false]] as const) {
			if (t) {
				parts.push({ text: t, changed: c });
			}
		}
	};
	for (const part of diffWordsWithSpace(mine, theirs)) {
		const changed = !!(part.added || part.removed);
		if (!part.added) {
			push(result.mine, part.value, changed);
		}
		if (!part.removed) {
			push(result.theirs, part.value, changed);
		}
	}
	return result;
}

export type ThreeWayKind = 'same' | 'conflict' | 'change' | 'deleted' | 'deletedConflict';

export interface ThreeWayPart {
	text: string;
	kind: ThreeWayKind;
}

// One place where a side changed the original: [start, end) in base (start === end for an insertion)
interface Hunk {
	start: number;
	end: number;
	parts: { text: string; removed: boolean; common?: boolean }[];
}

type SideItem = { same: string } | Hunk;

function sideHunks(base: string, side: string): SideItem[] {
	const items: SideItem[] = [];
	let pos = 0;
	let hunk: Hunk | undefined;
	for (const part of diffWordsWithSpace(base, side)) {
		if (!part.added && !part.removed) {
			if (hunk) {
				items.push(hunk);
				hunk = undefined;
			}
			items.push({ same: part.value });
			pos += part.value.length;
			continue;
		}
		hunk ??= { start: pos, end: pos, parts: [] };
		if (part.removed) {
			pos += part.value.length;
			hunk.end = pos;
		}
		hunk.parts.push({ text: part.value, removed: !!part.removed });
	}
	if (hunk) {
		items.push(hunk);
	}

	// Changes separated only by spaces on the same line are one edit ("one check 2" -> "3 — edited…")
	const merged: SideItem[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const prev = merged[merged.length - 1];
		const next = items[i + 1];
		if ('same' in item && /^[ \t]+$/.test(item.same) && prev && !('same' in prev) && next && !('same' in next)) {
			prev.parts.push({ text: item.same, removed: false, common: true }, ...next.parts);
			prev.end = next.end;
			i++;
			continue;
		}
		merged.push(item);
	}

	// A hunk that only changes whitespace doesn't count as a change
	return merged.map((item) =>
		'same' in item || item.parts.some((p) => /\S/.test(p.text))
			? item
			: { same: item.parts.filter((p) => !p.removed).map((p) => p.text).join('') }
	);
}

// Two changes collide when their ranges in the original overlap or touch
// (an insertion collides with a change that starts, ends or contains its position)
function collide(a: Hunk, b: Hunk): boolean {
	return Math.max(a.start, b.start) <= Math.min(a.end, b.end);
}

function pushTrimmed(out: ThreeWayPart[], text: string, kind: ThreeWayKind) {
	const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
	if (lead) {
		out.push({ text: lead, kind: 'same' });
	}
	if (core) {
		out.push({ text: core, kind });
	}
	if (trail) {
		out.push({ text: trail, kind: 'same' });
	}
}

/**
 * Compares each side with the original (diff3 base) and labels every change:
 * 'conflict' = both sides changed the same place, 'change' = only this side changed it,
 * 'deleted' / 'deletedConflict' = original text this side removed (shown struck through).
 * Joining the non-deleted parts of a side gives back exactly that side's text.
 */
export function threeWayDiff(base: string, mine: string, theirs: string): { mine: ThreeWayPart[]; theirs: ThreeWayPart[] } {
	const mineItems = sideHunks(base, mine);
	const theirsItems = sideHunks(base, theirs);
	const hunks = (items: SideItem[]) => items.filter((i): i is Hunk => !('same' in i));
	const mineHunks = hunks(mineItems);
	const theirsHunks = hunks(theirsItems);

	const render = (items: SideItem[], others: Hunk[]): ThreeWayPart[] => {
		const out: ThreeWayPart[] = [];
		for (const item of items) {
			if ('same' in item) {
				out.push({ text: item.same, kind: 'same' });
				continue;
			}
			const conflicting = others.some((other) => collide(item, other));
			// removed words of this edit shown together first, e.g. "~~one check 2~~ 3 — edited…"
			const removed = item.parts
				.filter((part) => part.removed)
				.map((part) => part.text.trim())
				.filter(Boolean)
				.join(' ');
			if (removed) {
				out.push({ text: removed, kind: conflicting ? 'deletedConflict' : 'deleted' });
			}
			// the new text of this edit as one highlight, spaces between its words included
			const added = item.parts
				.filter((part) => !part.removed)
				.map((part) => part.text)
				.join('');
			pushTrimmed(out, added, conflicting ? 'conflict' : 'change');
		}
		return out;
	};

	return { mine: render(mineItems, theirsHunks), theirs: render(theirsItems, mineHunks) };
}
