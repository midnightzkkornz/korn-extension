import { diffArrays } from 'diff';

/**
 * The WYSIWYG editor (Milkdown) writes the whole document back in its own markdown style
 * (`*` lists become `-`, `__bold__` becomes `**bold**`, blank lines collapse…).
 * This keeps the file's original text everywhere the user did not edit:
 *
 *   original  = the file as it is
 *   baseline  = what the editor produced for `original` before any edit
 *   edited    = what the editor produces now
 *
 * Lines changed between baseline → edited come from `edited`; every other line comes from
 * `original`. Where the editor restyled a block that the user then edited, that whole block
 * takes the edited version (the rest of the file is untouched).
 */
export function preserveFormatting(original: string, baseline: string, edited: string): string {
	if (edited === baseline) {
		return original;
	}
	const crlf = original.includes('\r\n');
	const O = original.split('\n').map((l) => (crlf ? l.replace(/\r$/, '') : l));
	const B = baseline.split('\n');
	const E = edited.split('\n');

	const toO = alignment(B, O, sameIgnoringStyle); // how the editor restyled the original
	const toE = alignment(B, E); // what the user changed (exact)

	// Parts of B that must come from `edited`: the user's changes, grown to cover any
	// restyled block they touch (so a block is never half original, half edited)
	const zones = mergeZones(toE.regions, toO.regions);

	// Edited list lines use the file's bullet: mixing "*" and "-" would split a list in two
	const bullet = preferredBullet(original);
	const fromEditor = (line: string) => line.replace(/^(\s*)[-*+](?=\s)/, `$1${bullet}`);

	const out: string[] = [];
	let k = 0;
	for (const zone of zones) {
		out.push(...O.slice(toO.lo[k], toO.lo[zone.s]));
		out.push(...E.slice(toE.lo[zone.s], toE.hi[zone.e]).map(fromEditor));
		k = zone.e;
	}
	out.push(...O.slice(toO.lo[k]));

	return out.join(crlf ? '\r\n' : '\n');
}

interface Region {
	s: number; // start line in B
	e: number; // end line in B (exclusive); s === e means lines were only inserted at s
}

/**
 * Line alignment of B against X.
 * lo[k] / hi[k] = index in X just before / just after anything X inserted before B line k.
 * regions = the ranges of B that differ in X.
 */
// "- a" / "* a", "**b**" / "__b__", "*i*" / "_i_" count as the same line when lining up
// the original with the editor's restyle of it
function styleKey(line: string): string {
	return line
		.trim()
		.replace(/^([-*+]|\d+[.)])\s+/, '• ')
		.replace(/\*\*|__/g, '')
		.replace(/[*_]/g, '');
}

function sameIgnoringStyle(a: string, b: string): boolean {
	return a === b || styleKey(a) === styleKey(b);
}

function alignment(B: string[], X: string[], comparator?: (a: string, b: string) => boolean) {
	const lo: number[] = new Array(B.length + 1);
	const hi: number[] = new Array(B.length + 1);
	const regions: Region[] = [];
	let b = 0;
	let x = 0;
	let open: { s: number; xs: number } | undefined; // changed block in progress: B from s, X from xs

	// A changed block B[s, b) ↔ X[xs, x): its X lines belong to the block, not before B[b]
	const close = () => {
		if (!open) {
			return;
		}
		regions.push({ s: open.s, e: b });
		if (open.s === b) {
			// pure insertion before B[b]
			lo[b] = open.xs;
			hi[b] = x;
		} else {
			for (let k = open.s; k < b; k++) {
				lo[k] = hi[k] = open.xs;
			}
			lo[b] = hi[b] = x;
		}
		open = undefined;
	};

	for (const part of diffArrays(B, X, comparator ? { comparator } : undefined)) {
		const n = part.count ?? part.value.length;
		if (!part.added && !part.removed) {
			close();
			for (let i = 0; i < n; i++, b++, x++) {
				lo[b] ??= x;
				hi[b] ??= x;
			}
			continue;
		}
		open ??= { s: b, xs: x };
		if (part.added) {
			x += n;
		} else {
			b += n;
		}
	}
	close();
	lo[b] ??= x;
	hi[b] ??= x;
	return { lo, hi, regions };
}

function overlaps(a: Region, b: Region, touching: boolean): boolean {
	if (touching) {
		return a.s <= b.e && b.s <= a.e;
	}
	// an empty region (pure insertion) counts only when strictly inside the other one
	if (a.s === a.e) {
		return b.s < a.s && a.s < b.e;
	}
	if (b.s === b.e) {
		return a.s < b.s && b.s < a.e;
	}
	return a.s < b.e && b.s < a.e;
}

function mergeZones(edits: Region[], restyled: Region[]): Region[] {
	const zones = edits.map((r) => ({ ...r }));
	let changed = true;
	while (changed) {
		changed = false;
		for (const zone of zones) {
			for (const r of restyled) {
				if (overlaps(zone, r, false) && (r.s < zone.s || r.e > zone.e)) {
					zone.s = Math.min(zone.s, r.s);
					zone.e = Math.max(zone.e, r.e);
					changed = true;
				}
			}
		}
		zones.sort((a, b) => a.s - b.s || a.e - b.e);
		for (let i = 0; i + 1 < zones.length; i++) {
			if (overlaps(zones[i], zones[i + 1], true)) {
				zones[i].e = Math.max(zones[i].e, zones[i + 1].e);
				zones.splice(i + 1, 1);
				i--;
				changed = true;
			}
		}
	}
	return zones;
}

/** "*" or "-" (whichever the file uses more) so edited list lines keep the file's style */
export function preferredBullet(markdown: string): '*' | '-' {
	const stars = (markdown.match(/^\s*\* /gm) ?? []).length;
	const dashes = (markdown.match(/^\s*- /gm) ?? []).length;
	return stars > dashes ? '*' : '-';
}
