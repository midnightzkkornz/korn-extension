import { parseConflicts, buildResult, hasConflictMarkers, Segment, wordDiff, threeWayDiff, ThreeWayPart } from '../../webview/editor/resolve/conflictParser';
let failed = 0;
const eq = (name: string, a: unknown, b: unknown) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) { failed++; console.log('  got ', JSON.stringify(a)); console.log('  want', JSON.stringify(b)); } };
const conflicts = (s: Segment[] | null) => (s ?? []).filter((x) => x.kind === 'conflict');

const one = '# Note\n\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\nend\n';
const s1 = parseConflicts(one)!;
eq('1 conflict count', conflicts(s1).length, 1);
eq('1 conflict parts', conflicts(s1)[0], { kind: 'conflict', mine: 'mine\n', theirs: 'theirs\n', mineLabel: 'HEAD', theirsLabel: 'origin/main' });
eq('mine', buildResult(s1, [{ type: 'mine' }]), '# Note\n\nmine\nend\n');
eq('theirs', buildResult(s1, [{ type: 'theirs' }]), '# Note\n\ntheirs\nend\n');
eq('both mine first', buildResult(s1, [{ type: 'mineFirst' }]), '# Note\n\nmine\ntheirs\nend\n');
eq('both theirs first', buildResult(s1, [{ type: 'theirsFirst' }]), '# Note\n\ntheirs\nmine\nend\n');
eq('edit adds newline', buildResult(s1, [{ type: 'edit', text: 'custom' }]), '# Note\n\ncustom\nend\n');

const diff3 = 'a\n<<<<<<< HEAD\nx1\n||||||| base\nx0\n=======\nx2\n>>>>>>> origin/main\nb\n<<<<<<< HEAD\ny1\n=======\ny2\n>>>>>>> origin/main\n';
const s2 = parseConflicts(diff3)!;
eq('diff3 + 2 conflicts', conflicts(s2).length, 2);
eq('base captured', (conflicts(s2)[0] as any).base, 'x0\n');
eq('mixed choices', buildResult(s2, [{ type: 'theirs' }, { type: 'mine' }]), 'a\nx2\nb\ny1\n');

const crlf = 'a\r\n<<<<<<< HEAD\r\nm\r\n=======\r\nt\r\n>>>>>>> x\r\nz\r\n';
eq('CRLF', buildResult(parseConflicts(crlf)!, [{ type: 'mine' }]), 'a\r\nm\r\nz\r\n');

eq('no conflicts', parseConflicts('# hi\n\ntext\n'), []);
eq('setext heading ok', parseConflicts('Title\n=======\n'), []);
eq('unterminated -> null', parseConflicts('<<<<<<< HEAD\nm\n=======\nt\n'), null);
eq('stray end -> null', parseConflicts('a\n>>>>>>> x\n'), null);
eq('nested -> null', parseConflicts('<<<<<<< a\n<<<<<<< b\n=======\n>>>>>>> c\n'), null);
eq('markers detected', hasConflictMarkers(one), true);

const fence = '```\n<<<<<<< HEAD\ncode a\n=======\ncode b\n>>>>>>> o\n```\n';
eq('conflict inside code fence', buildResult(parseConflicts(fence)!, [{ type: 'theirs' }]), '```\ncode b\n```\n');

const noEol = 'a\n<<<<<<< HEAD\nm\n=======\nt\n>>>>>>> o';
eq('file without final newline', buildResult(parseConflicts(noEol)!, [{ type: 'mine' }]), 'a\nm\n');
eq('empty side', buildResult(parseConflicts('<<<<<<< H\n=======\nt\n>>>>>>> o\n')!, [{ type: 'mineFirst' }]), 't\n');

// word diff must rebuild each side exactly (bug: "2-2" moved to a new line)
for (const [name, mine, theirs] of [
	['screenshot case', 'line one check 2-2\nline two check 2-2\n', 'line 3 — edited by other person at 15:56:32\nline two check\n'],
	['space vs newline', 'a b\n', 'a\nb\n'],
	['CRLF', 'x y\r\nz\r\n', 'x\r\ny z\r\n'],
	['empty side', '', 'only theirs\n'],
] as const) {
	const d = wordDiff(mine, theirs);
	eq(`wordDiff ${name}: mine exact`, d.mine.map((p) => p.text).join(''), mine);
	eq(`wordDiff ${name}: theirs exact`, d.theirs.map((p) => p.text).join(''), theirs);
}
const ws = wordDiff('a b\n', 'a\nb\n');
eq('whitespace-only parts not highlighted', ws.mine.filter((p) => p.changed).length + ws.theirs.filter((p) => p.changed).length, 0);
const d2 = wordDiff('line two check 2-2\n', 'line two check\n');
eq('changed word highlighted', d2.mine.filter((p) => p.changed).map((p) => p.text), ['2-2']);

// three-way: tell real conflicts from one-sided changes
const visible = (parts: ThreeWayPart[]) => parts.filter((p) => !p.kind.startsWith('deleted')).map((p) => p.text).join('');
const kinds = (parts: ThreeWayPart[], kind: string) => parts.filter((p) => p.kind === kind).map((p) => p.text);
{
	const base = 'line one check 2\nline two check\n';
	const mine = 'line one check 2-2\nline two check 2-2\n';
	const theirs = 'line 3 — edited by other person at 15:56:32\nline two check\n';
	const d = threeWayDiff(base, mine, theirs);
	console.log('  mine  :', JSON.stringify(d.mine.filter((p) => p.kind !== 'same')));
	console.log('  theirs:', JSON.stringify(d.theirs.filter((p) => p.kind !== 'same')));
	eq('3way screenshot: mine exact', visible(d.mine), mine);
	eq('3way screenshot: theirs exact', visible(d.theirs), theirs);
	eq('3way screenshot: mine line 1 is conflict', kinds(d.mine, 'conflict').join('').includes('-2'), true);
	eq('3way screenshot: mine line 2 "2-2" is one-sided change', kinds(d.mine, 'change'), ['2-2']);
	eq('3way screenshot: theirs line 1 is conflict', kinds(d.theirs, 'conflict').length > 0 && kinds(d.theirs, 'change').length === 0, true);
	eq('3way screenshot: theirs line 1 all conflict', kinds(d.theirs, 'conflict'), ['3 — edited by other person at 15:56:32']);
	eq('3way screenshot: theirs line 2 untouched', d.theirs.slice(-1)[0], { text: '\nline two check\n', kind: 'same' });
}
{
	const d = threeWayDiff('the quick brown fox\n', 'the slow brown fox\n', 'the quick brown cat\n');
	eq('3way different words: no conflict', [...kinds(d.mine, 'conflict'), ...kinds(d.theirs, 'conflict')], []);
	eq('3way different words: changes', [kinds(d.mine, 'change'), kinds(d.theirs, 'change')], [['slow'], ['cat']]);
	eq('3way different words: deleted shown', [kinds(d.mine, 'deleted'), kinds(d.theirs, 'deleted')], [['quick'], ['fox']]);
}
{
	const d = threeWayDiff('a keep b\n', 'a keep\n', 'a keep c\n');
	eq('3way delete vs edit: mine deletedConflict', kinds(d.mine, 'deletedConflict'), ['b']);
	eq('3way delete vs edit: theirs conflict', kinds(d.theirs, 'conflict'), ['c']);
	eq('3way delete vs edit: exact', [visible(d.mine), visible(d.theirs)], ['a keep\n', 'a keep c\n']);
}
{
	const d = threeWayDiff('x\n', 'x \n', 'y\n');
	eq('3way whitespace-only change is not a change', kinds(d.mine, 'change').length + kinds(d.mine, 'conflict').length, 0);
	eq('3way whitespace-only: exact', visible(d.mine), 'x \n');
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
