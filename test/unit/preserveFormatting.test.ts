import { preferredBullet, preserveFormatting } from '../../webview/editor/preserveFormatting';

let failed = 0;
const eq = (name: string, a: unknown, b: unknown) => {
	const ok = JSON.stringify(a) === JSON.stringify(b);
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
	if (!ok) {
		failed++;
		console.log('  got ', JSON.stringify(a));
		console.log('  want', JSON.stringify(b));
	}
};

// original = the file · baseline = the editor's restyle of it · edited = after the user's change
const original = '* a\n* b\n\npara one\n\n\n__bold__ text\n\nTitle\n=====\n\nend';
const baseline = '- a\n- b\n\npara one\n\n**bold** text\n\n# Title\n\nend\n';

eq('nothing edited → original exactly', preserveFormatting(original, baseline, baseline), original);

eq(
	'edit one paragraph → only that line changes',
	preserveFormatting(original, baseline, baseline.replace('para one', 'para two')),
	original.replace('para one', 'para two')
);

eq(
	'edit one list item → only that item changes, keeping the file\'s "*" bullet',
	preserveFormatting(original, baseline, baseline.replace('- b', '- b2')),
	'* a\n* b2\n\npara one\n\n\n__bold__ text\n\nTitle\n=====\n\nend'
);

eq(
	'add a list item → uses the file\'s bullet',
	preserveFormatting(original, baseline, baseline.replace('- b\n', '- b\n- c\n')),
	'* a\n* b\n* c\n\npara one\n\n\n__bold__ text\n\nTitle\n=====\n\nend'
);

eq(
	'edit the setext heading (2 lines restyled into 1) → heading block takes the editor style',
	preserveFormatting(original, baseline, baseline.replace('# Title', '# New title')),
	'* a\n* b\n\npara one\n\n\n__bold__ text\n\n# New title\n\nend'
);

eq(
	'edit the restyled bold line → that line only',
	preserveFormatting(original, baseline, baseline.replace('**bold** text', '**bold** words')),
	'* a\n* b\n\npara one\n\n**bold** words\n\nTitle\n=====\n\nend'
);

eq(
	'add a new paragraph → inserted, rest untouched',
	preserveFormatting(original, baseline, baseline.replace('para one\n', 'para one\n\nnew para\n')),
	'* a\n* b\n\npara one\n\nnew para\n\n\n__bold__ text\n\nTitle\n=====\n\nend'
);

eq(
	'delete a paragraph → removed, rest untouched',
	preserveFormatting(original, baseline, baseline.replace('para one\n\n', '')),
	'* a\n* b\n\n\n__bold__ text\n\nTitle\n=====\n\nend'
);

eq(
	'edit first line',
	preserveFormatting('Intro\n\n* x\n', 'Intro\n\n- x\n', 'Intro!\n\n- x\n'),
	'Intro!\n\n* x\n'
);

eq(
	'edit last line (file without final newline keeps having none)',
	preserveFormatting('* x\n\nlast', '- x\n\nlast\n', '- x\n\nlast line\n'),
	'* x\n\nlast line'
);

eq(
	'append at the end',
	preserveFormatting('* x\n', '- x\n', '- x\n\nmore\n'),
	'* x\n\nmore\n'
);

eq(
	'CRLF file keeps CRLF',
	preserveFormatting('* a\r\n\r\npara\r\n', '- a\n\npara\n', '- a\n\npara 2\n'),
	'* a\r\n\r\npara 2\r\n'
);

eq(
	'identical styles → same as edited',
	preserveFormatting('# T\n\ntext\n', '# T\n\ntext\n', '# T\n\ntext 2\n'),
	'# T\n\ntext 2\n'
);

eq('bullet: file uses *', preferredBullet('* a\n* b\n- c\n'), '*');
eq('bullet: file uses -', preferredBullet('- a\n\ntext\n'), '-');

console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
