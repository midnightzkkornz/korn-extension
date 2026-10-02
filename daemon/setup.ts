import { createInterface } from 'node:readline/promises';
import * as path from 'path';
import { runGit } from '../src/git/ops';
import { ConflictPreset, FrequencyPreset, initConfig, OpenSetting, setRepoOptions, setTopLevel } from './config';
import { hasVSCode } from './opener';
import { startService } from './service';

// `korn setup`: a few questions instead of editing config.yaml

const CONFLICT_CHOICES: { preset: ConflictPreset; label: string }[] = [
	{ preset: 'keepBoth', label: 'เก็บทั้งสองไว้ — ในไฟล์เป็นของอีกคน ของคุณเก็บเป็นไฟล์สำเนา (ไม่ต้องทำอะไร)' },
	{ preset: 'ask', label: 'ถามฉัน — เลือกเองทีละจุด (ใน VS Code หรือ terminal)' },
	{ preset: 'mine', label: 'ใช้ของฉัน' },
];

const FREQUENCY_CHOICES: { preset: FrequencyPreset; label: string }[] = [
	{ preset: 'fast', label: 'เร็ว — แก้เสร็จ 1 นาทีก็ sync, ดึงของคนอื่นทุก 2 นาที' },
	{ preset: 'normal', label: 'ปกติ — 5 นาที / ทุก 10 นาที' },
	{ preset: 'relaxed', label: 'ประหยัด — 15 นาที / ทุก 30 นาที' },
];

export async function setup(kornScript: string): Promise<number> {
	if (!process.stdin.isTTY) {
		console.error('korn setup ต้องรันใน terminal (หรือใช้ korn set <path> --conflict … --frequency …)');
		return 2;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = async (question: string, fallback: string) => (await rl.question(question)).trim() || fallback;
	const choose = async <T>(title: string, choices: { preset: T; label: string }[]): Promise<T> => {
		console.log(`\n${title}`);
		choices.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
		for (;;) {
			const n = Number(await ask(`เลือก [1]: `, '1'));
			if (n >= 1 && n <= choices.length) {
				return choices[n - 1].preset;
			}
		}
	};

	try {
		console.log('ตั้งค่า korn — sync โน้ตผ่าน git เบื้องหลัง (กด Enter = ใช้ค่าในวงเล็บ)\n');

		// 1. repo
		let root: string | undefined;
		const here = await runGit(['rev-parse', '--show-toplevel'], process.cwd()).then((s) => s.trim(), () => '');
		while (!root) {
			const answer = await ask(`โฟลเดอร์โน้ต (git repo)${here ? ` [${here}]` : ''}: `, here);
			const dir = path.resolve(answer.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
			root = await runGit(['rev-parse', '--show-toplevel'], dir).then(
				(s) => s.trim(),
				() => {
					console.log(`  ${dir} ไม่ใช่ git repo ลองใหม่`);
					return undefined;
				}
			);
		}
		const remote = (await runGit(['remote'], root)).trim().split('\n')[0];
		if (!remote) {
			console.log('  ⚠ repo นี้ยังไม่มี remote — จะ commit ในเครื่องได้ แต่ยัง push ไม่ได้ (git remote add origin <url>)');
		} else {
			const reachable = await runGit(['ls-remote', '--heads', remote], root).then(() => true, () => false);
			console.log(reachable ? `  ✓ ต่อ ${remote} ได้` : `  ⚠ ต่อ ${remote} ไม่ได้ตอนนี้ — เช็ก login/ssh key ก่อน (korn doctor)`);
		}

		// 2–3. plain choices
		const conflict = await choose('เมื่อคุณกับคนอื่นแก้บรรทัดเดียวกัน:', CONFLICT_CHOICES);
		const frequency = await choose('ความถี่:', FREQUENCY_CHOICES);
		// Where "เลือกเลย" opens a conflict: only a question when VS Code is installed
		const open: OpenSetting = hasVSCode()
			? await choose('เวลาต้องเลือก (แก้ชนกัน) ให้เปิดใน:', [
					{ preset: 'vscode' as OpenSetting, label: 'VS Code — แท็บ Resolve ของ Korn' },
					{ preset: 'terminal' as OpenSetting, label: 'Terminal — korn resolve ถามทีละจุด' },
				])
			: 'terminal';

		initConfig();
		setRepoOptions(root, { conflict, frequency });
		setTopLevel('open', open);

		// 4. background
		const start = (await ask('\nเริ่ม sync เบื้องหลังเลยไหม (ทำงานแม้ปิด terminal/VS Code และตอนเปิดเครื่อง) [Y/n]: ', 'y')).toLowerCase();
		console.log('');
		if (start.startsWith('y')) {
			startService(kornScript);
			console.log(`✓ เปิด sync เบื้องหลังแล้ว: ${path.basename(root)}`);
		} else {
			console.log(`บันทึกแล้ว เริ่มเมื่อพร้อมด้วย: korn start`);
		}
		console.log('ดูสถานะ: พิมพ์ korn · หยุด: korn stop');
		return 0;
	} finally {
		rl.close();
	}
}
