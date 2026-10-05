import { execFileSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, watchFile, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createInterface } from 'node:readline/promises';
import * as path from 'path';
import { lockHolder } from '../src/git/lock';
import { formatDate, pendingMerge, runGit } from '../src/git/ops';
import { buildResult, Choice, hasConflictMarkers, parseConflicts, Segment } from '../webview/editor/resolve/conflictParser';
import {
	addRepo,
	Config,
	ConfigError,
	CONFLICT_PRESETS,
	ConflictPreset,
	configPath,
	FREQUENCY_PRESETS,
	FrequencyPreset,
	initConfig,
	loadConfig,
	removeRepo,
	RepoConfig,
	setRepoOptions,
} from './config';
import { conflictCopyName, finishMergeResolve, resolvePaused, ResolveChoice, runRound } from './engine';
import { createNotifier } from './notify';
import { describe, overview } from './overview';
import { startService, stopService } from './service';
import { setup } from './setup';
import { uninstall } from './uninstall';
import { clearPid, daemonPid, log, logFile, readPaused, readState, setPaused, writePid } from './state';
import { VERSION } from './version';

// korn — sync markdown notes through git in the background (the daemon of Korn Markdown Sync)

const HELP = `korn ${VERSION} — sync โน้ต markdown ผ่าน git เบื้องหลัง

  korn                  ดูสถานะ (และสิ่งที่ต้องทำต่อ ถ้ามี)
  korn setup            ตั้งค่าแบบถามตอบ แล้วเริ่มทำงาน
  korn start            เริ่ม sync เบื้องหลัง (ทำงานต่อแม้ปิด terminal และตอนเปิดเครื่อง)
  korn stop             หยุด sync เบื้องหลัง
  korn resolve [file]   เลือกของเรา/ของอีกคนทีละจุด เมื่อแก้ชนกัน
  korn log [-f]         ดูว่าทำอะไรไปบ้าง
  korn uninstall        หยุดและลบทุกอย่างที่ korn ทิ้งไว้ในเครื่อง (ก่อนถอนแพ็กเกจ)

คำสั่งทั้งหมด: korn help --all`;

const HELP_ALL = `korn ${VERSION} — all commands

Setup
  korn setup                     questions instead of editing the config
  korn set <path> [--conflict keepBoth|ask|mine] [--frequency fast|normal|relaxed]
  korn init                      create ${configPath()}
  korn add [path] / korn remove [path]
  korn doctor                    check git, config and push access

Run
  korn start / korn stop         background service (LaunchAgent on macOS, systemd --user on Linux)
  korn uninstall [--all | --keep-config]
                                 stop it and clean up before removing the package
  korn daemon                    run in this terminal instead
  korn sync [path]               one round now, ignoring the quiet time

Look
  korn                           summary and what to do next
  korn status [--json]           details (--json: for the VS Code extension)
  korn log [-f]

Conflicts
  korn resolve [file…]           pick mine / theirs / both for each conflict, then push
  korn resolve <file…> --mine | --theirs | --copy
  korn pause <file> / korn resume <file>

Settings beyond these (include/exclude, rules, notify): ${configPath()}
Docs: https://github.com/midnightzkkornz/korn-extension/blob/main/docs/daemon.md`;

const TICK_MS = 30_000;

async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
	switch (command) {
		case undefined: {
			const o = await overview();
			console.log(describe(o));
			// something waits for a choice: offer to do it right here
			if (process.stdin.isTTY && o.repos.some((r) => r.needsChoice.length > 0)) {
				const answer = (await ask('\nเลือกตอนนี้เลยไหม? [Y/n] ')).toLowerCase();
				if (answer === '' || answer.startsWith('y')) {
					return resolve([], { all: true });
				}
			}
			return 0;
		}
		case 'help':
		case '-h':
		case '--help':
			console.log(args.includes('--all') ? HELP_ALL : HELP);
			return 0;
		case 'setup':
			return setup(kornScript());
		case 'start':
			return start();
		case 'stop':
			return stop();
		case 'uninstall':
			return uninstall(kornScript(), args);
		case 'set':
			return set(args);
		case '-v':
		case '--version':
		case 'version':
			console.log(VERSION);
			return 0;
		case 'init':
			return init();
		case 'add':
			return add(args[0]);
		case 'remove':
			return remove(args[0]);
		case 'daemon':
			return daemon();
		case 'sync':
			return syncNow(args[0]);
		case 'status':
			if (args.includes('--json')) {
				console.log(JSON.stringify(await overview()));
				return 0;
			}
			return status();
		case 'log':
			return showLog(args.includes('-f') || args.includes('--follow'));
		case 'pause':
		case 'resume':
			return pauseResume(command, args);
		case 'resolve':
			return resolve(args);
		case 'doctor':
			return doctor();
		default:
			console.error(`korn: ไม่รู้จักคำสั่ง "${command}"\n\n${HELP}`);
			return 2;
	}
}

function init(): number {
	if (initConfig()) {
		console.log(`สร้าง ${configPath()} แล้ว\nต่อไป: korn add ~/path/to/notes-repo`);
	} else {
		console.log(`มี ${configPath()} อยู่แล้ว`);
	}
	return 0;
}

async function repoRoot(dir: string): Promise<string> {
	try {
		return path.resolve((await runGit(['rev-parse', '--show-toplevel'], dir)).trim());
	} catch {
		throw new Error(`${dir} ไม่ได้อยู่ใน git repo`);
	}
}

async function add(dir = '.'): Promise<number> {
	const root = await repoRoot(path.resolve(dir));
	initConfig();
	console.log(addRepo(root) ? `เพิ่ม ${root} แล้ว (ความถี่ปกติ, แก้ชนกัน = เก็บทั้งสองไว้)` : `${root} อยู่ใน config แล้ว`);
	if (!daemonPid()) {
		console.log('sync เบื้องหลังยังไม่ทำงาน — พิมพ์: korn start');
	}
	return 0;
}

// The korn.js being run (copied by `korn start` to a fixed place for the background service)
function kornScript(): string {
	return path.resolve(process.argv[1]);
}

function start(): number {
	const config = loadConfig();
	startService(kornScript());
	console.log(`✓ เริ่ม sync เบื้องหลังแล้ว (${config.repos.length} repo) — ทำงานต่อแม้ปิด terminal และตอนเปิดเครื่อง`);
	if (config.repos.length === 0) {
		console.log('ยังไม่มี repo — korn setup หรือ korn add <path>');
	}
	console.log('ดูสถานะ: korn · หยุด: korn stop');
	return 0;
}

function stop(): number {
	const wasOn = stopService();
	console.log(wasOn ? '✓ หยุด sync เบื้องหลังแล้ว (การตั้งค่ายังอยู่ เริ่มใหม่ด้วย korn start)' : 'sync เบื้องหลังไม่ได้เปิดอยู่');
	return 0;
}

// korn set <path> --conflict keepBoth|ask|mine --frequency fast|normal|relaxed
async function set(args: string[]): Promise<number> {
	const value = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const conflict = value('--conflict');
	const frequency = value('--frequency');
	const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '.';
	if (conflict && !(conflict in CONFLICT_PRESETS)) {
		throw new Error(`--conflict ต้องเป็น ${Object.keys(CONFLICT_PRESETS).join(' | ')}`);
	}
	if (frequency && !(frequency in FREQUENCY_PRESETS)) {
		throw new Error(`--frequency ต้องเป็น ${Object.keys(FREQUENCY_PRESETS).join(' | ')}`);
	}
	const root = await repoRoot(path.resolve(target));
	initConfig();
	setRepoOptions(root, { conflict: conflict as ConflictPreset | undefined, frequency: frequency as FrequencyPreset | undefined });
	console.log(`บันทึกแล้ว: ${path.basename(root)}`);
	return 0;
}

async function remove(dir = '.'): Promise<number> {
	const target = path.resolve(dir);
	const root = existsSync(target) ? await repoRoot(target).catch(() => target) : target;
	console.log(removeRepo(root) ? `เอา ${root} ออกแล้ว` : `${root} ไม่ได้อยู่ใน config`);
	return 0;
}

// ---- daemon ----

async function daemon(): Promise<number> {
	const running = daemonPid();
	if (running && running !== process.pid) {
		console.error(`korn daemon ทำงานอยู่แล้ว (pid ${running})`);
		return 1;
	}
	writePid(VERSION);
	let config: Config | undefined;
	const reload = () => {
		try {
			config = loadConfig();
			log(`config loaded: ${config.repos.length} repo(s)`);
		} catch (error) {
			log(`config: ${(error as Error).message}`);
			if (!config) {
				console.error((error as Error).message); // the service log (daemon.out.log)
			}
		}
	};
	reload();
	watchFile(configPath(), { interval: 5000 }, reload); // picks up edits without a restart

	let stopping = false;
	const stop = () => {
		stopping = true;
		clearPid();
		log('daemon stopped');
		process.exit(0);
	};
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	log(`daemon started (pid ${process.pid}, korn ${VERSION})`);

	while (!stopping) {
		for (const repo of config?.repos ?? []) {
			await runRound(repo, { notify: createNotifier(config?.notify ?? 'auto', config?.open) });
		}
		await new Promise((resolve) => setTimeout(resolve, TICK_MS));
	}
	return 0;
}

// ---- one-off commands ----

function configOrExit(): Config {
	return loadConfig();
}

async function findRepo(config: Config, target: string): Promise<{ repo: RepoConfig; file?: string }> {
	const full = path.resolve(target);
	const repo = config.repos
		.filter((r) => full === r.path || full.startsWith(r.path + path.sep))
		.sort((a, b) => b.path.length - a.path.length)[0];
	if (!repo) {
		throw new Error(`${full} ไม่ได้อยู่ใน repo ที่ตั้งไว้ (korn add ก่อน)`);
	}
	const file = full === repo.path ? undefined : path.relative(repo.path, full).split(path.sep).join('/');
	return { repo, file };
}

async function syncNow(target?: string): Promise<number> {
	const config = configOrExit();
	const repos = target ? [(await findRepo(config, target)).repo] : config.repos;
	if (repos.length === 0) {
		console.log('ยังไม่มี repo — korn add <path>');
		return 0;
	}
	let failed = 0;
	for (const repo of repos) {
		const r = await runRound(repo, { force: true, notify: createNotifier(config.notify, config.open) });
		const parts = [
			r.committed.length ? `committed ${r.committed.length}` : '',
			r.pulled ? 'pulled' : '',
			r.resolved.length ? `resolved ${r.resolved.map((d) => `${d.file} (${d.policy})`).join(', ')}` : '',
			r.paused.length ? `paused ${r.paused.join(', ')} (conflict)` : '',
			r.pushed ? 'pushed' : '',
			r.skipped ? `skipped: ${r.skipped}` : '',
			r.error ? `error: ${r.error}` : '',
		].filter(Boolean);
		console.log(`${tilde(repo.path)}: ${parts.join(' · ') || 'up to date'}`);
		failed += r.error ? 1 : 0;
	}
	return failed ? 1 : 0;
}

function tilde(p: string): string {
	const home = process.env.HOME ?? '';
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function ago(iso?: string): string {
	return iso ? formatDate(new Date(iso)) : 'never';
}

async function status(): Promise<number> {
	const pid = daemonPid();
	console.log(pid ? `daemon: running (pid ${pid})` : 'daemon: not running — korn start');
	let config: Config;
	try {
		config = loadConfig();
	} catch (error) {
		console.log((error as Error).message);
		return 1;
	}
	const states = readState();
	if (config.repos.length === 0) {
		console.log('no repos — korn add <path>');
	}
	for (const repo of config.repos) {
		const s = states[repo.path] ?? {};
		console.log(`\n${tilde(repo.path)}  ${s.branch ? `⎇ ${s.branch}${s.upstream ? ` → ${s.upstream}` : ''}` : ''}`);
		console.log(`  last sync ${ago(s.lastSync)} · last pull ${ago(s.lastPull)} · checked ${ago(s.lastRound)}`);
		for (const w of s.waiting ?? []) {
			const minutes = Math.max(0, Math.ceil((Date.parse(w.readyAt) - Date.now()) / 60_000));
			console.log(`  waiting  ${w.file} (commit in ${minutes} min)`);
		}
		if (existsSync(repo.path)) {
			for (const file of (await pendingMerge(repo.path).catch(() => undefined)) ?? []) {
				console.log(`  CONFLICT ${file} — เลือกใน VS Code (Korn → Resolve) หรือ: korn resolve ${file}`);
			}
			for (const [file, p] of Object.entries(await readPaused(repo.path).catch(() => ({})))) {
				console.log(
					p.reason === 'conflict'
						? `  PAUSED   ${file} — conflict: korn resolve ${file} --mine | --theirs | --copy`
						: `  paused   ${file} (korn resume ${file})`
				);
			}
			const holder = await lockHolder(repo.path).catch(() => undefined);
			if (holder) {
				console.log(`  syncing now (${holder.owner})`);
			}
		}
		if (s.skipped) {
			console.log(`  skipped: ${s.skipped}`);
		}
		if (s.error) {
			console.log(`  ERROR: ${s.error}`);
		}
	}
	return 0;
}

function showLog(follow: boolean): Promise<number> {
	const file = logFile();
	if (!existsSync(file)) {
		console.log('ยังไม่มี log');
		return Promise.resolve(0);
	}
	if (follow) {
		const tail = spawn('tail', ['-n', '50', '-f', file], { stdio: 'inherit' });
		return new Promise((resolve) => tail.on('exit', (code) => resolve(code ?? 0)));
	}
	const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
	console.log(lines.slice(-50).join('\n'));
	return Promise.resolve(0);
}

async function pauseResume(command: 'pause' | 'resume', args: string[]): Promise<number> {
	if (args.length === 0) {
		console.error(`korn ${command} <file>`);
		return 2;
	}
	const config = configOrExit();
	for (const target of args) {
		const { repo, file } = await findRepo(config, target);
		if (!file) {
			throw new Error(`ระบุไฟล์ ไม่ใช่ทั้ง repo: ${target}`);
		}
		if (command === 'pause') {
			await setPaused(repo.path, file, { reason: 'user', since: new Date().toISOString() });
			console.log(`หยุด sync ${file} แล้ว (korn resume ${file} เพื่อเริ่มใหม่)`);
		} else {
			const paused = (await readPaused(repo.path))[file];
			if (paused?.reason === 'conflict') {
				console.error(`${file} หยุดเพราะ conflict — ใช้ korn resolve ${file} --mine | --theirs | --copy`);
				return 1;
			}
			await setPaused(repo.path, file, undefined);
			console.log(`sync ${file} ต่อแล้ว`);
		}
		log(`${path.basename(repo.path)}: ${command} ${file}`);
	}
	return 0;
}

const RESOLVE_USAGE = `korn resolve [file…]                 pick mine / theirs / both for each conflict (asks)
korn resolve <file…> --mine | --theirs | --copy
  --mine    ใช้ของเรา
  --theirs  ใช้ของอีกคน
  --copy    ใช้ของอีกคน และเก็บของเราเป็นไฟล์ .conflict-…`;

// One question at a time with its own readline, so an editor ($EDITOR) can take the terminal in between
async function ask(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
	}
}

/**
 * korn resolve: files given → those; inside a repo → that repo; anywhere else (or all: true) → every repo.
 * Asks per conflict unless --mine / --theirs / --copy.
 */
async function resolve(args: string[], { all = false } = {}): Promise<number> {
	const flags = args.filter((a) => ['--mine', '--theirs', '--copy'].includes(a));
	const targets = args.filter((a) => !a.startsWith('--'));
	if (flags.length > 1 || args.some((a) => a.startsWith('--') && !flags.includes(a))) {
		console.error(RESOLVE_USAGE);
		return 2;
	}
	const choice = flags[0]?.slice(2) as ResolveChoice | undefined;
	const config = configOrExit();

	let work: { repo: RepoConfig; files: string[] }[];
	if (targets.length) {
		const found = await Promise.all(targets.map((t) => findRepo(config, t)));
		if (found.some((f) => f.repo !== found[0].repo || !f.file)) {
			throw new Error('ระบุไฟล์ใน repo เดียวกัน');
		}
		work = [{ repo: found[0].repo, files: found.map((f) => f.file!) }];
	} else {
		const here = all ? undefined : await findRepo(config, '.').catch(() => undefined);
		work = (here ? [here.repo] : config.repos).map((repo) => ({ repo, files: [] }));
	}

	let handled = 0;
	for (const { repo, files } of work) {
		if (existsSync(repo.path)) {
			handled += await resolveRepo(repo, files, choice);
		}
	}
	if (handled === 0) {
		console.log('✓ ไม่มีอะไรต้องเลือก');
	}
	return 0;
}

/** Returns how many files it handled */
async function resolveRepo(repo: RepoConfig, files: string[], choice: ResolveChoice | undefined): Promise<number> {
	// Policy "ask" (resolve): a merge with conflict markers is waiting
	const unmerged = await pendingMerge(repo.path);
	if (unmerged) {
		const todo = files.length ? files : unmerged;
		const notInMerge = todo.filter((f) => !unmerged.includes(f));
		if (notInMerge.length) {
			throw new Error(`${notInMerge.join(', ')} ไม่ได้มี conflict รออยู่ (ที่รอ: ${unmerged.join(', ') || '-'})`);
		}
		const writes: { file: string; text: string }[] = [];
		for (const file of todo) {
			const text = readFileSync(path.join(repo.path, file), 'utf8');
			const segments = parseConflicts(text);
			if (!segments || segments.length === 0) {
				if (hasConflictMarkers(text)) {
					throw new Error(`แยก conflict ใน ${file} ไม่ได้ (marker ไม่ครบ) — แก้ไฟล์เองแล้วลบ marker ออก`);
				}
				continue; // already resolved
			}
			const picked = choice ? pickAll(segments, choice) : await pickInteractive(`${path.basename(repo.path)}/${file}`, segments);
			if (!picked) {
				console.log('ยกเลิก — ยังไม่ได้บันทึกอะไร');
				return todo.length;
			}
			writes.push({ file, text: buildResult(segments, picked) });
			if (choice === 'copy') {
				// --copy: the file takes theirs, ours goes to a copy (like "keep both")
				const copy = conflictCopyName(repo.path, file, new Date());
				writeFileSync(path.join(repo.path, copy), buildResult(segments, pickAll(segments, 'mine')));
				await runGit(['add', '--', copy], repo.path);
				console.log(`เก็บของเราไว้ที่ ${copy}`);
			}
		}
		console.log(`✓ ${await finishMergeResolve(repo, writes)}`);
		return todo.length;
	}

	// Policy "pause": files waiting for a side to be picked for the whole file
	const paused = Object.entries(await readPaused(repo.path))
		.filter(([, p]) => p.reason === 'conflict')
		.map(([f]) => f);
	const todo = files.length ? files : paused;
	if (todo.length === 0) {
		return 0;
	}
	let pick = choice;
	if (!pick) {
		if (!process.stdin.isTTY) {
			throw new Error(`ต้องรันใน terminal หรือใส่ --mine | --theirs | --copy`);
		}
		console.log(`\n${path.basename(repo.path)}: ${todo.join(', ')} ถูกแก้ทั้งสองฝั่ง`);
		for (;;) {
			const answer = await ask('  เลือก m = ใช้ของเรา · t = ใช้ของอีกคน · c = เก็บทั้งสอง (ของเราเป็นไฟล์สำเนา) · q = ยกเลิก > ');
			if (answer === 'q') {
				return todo.length;
			}
			pick = ({ m: 'mine', t: 'theirs', c: 'copy' } as const)[answer as 'm' | 't' | 'c'];
			if (pick) {
				break;
			}
		}
	}
	console.log(`✓ ${await resolvePaused(repo, todo, pick)}`);
	return todo.length;
}

// --mine / --theirs / --copy on a merge: the same side for every conflict
function pickAll(segments: Segment[], choice: ResolveChoice): Choice[] {
	const type = choice === 'mine' ? 'mine' : 'theirs';
	return segments.filter((s) => s.kind === 'conflict').map(() => ({ type }));
}

// Text typed in $EDITOR for one conflict (starts with both sides, like VS Code's "Accept Both")
function editInEditor(start: string): string | undefined {
	const tmp = path.join(mkdtempSync(path.join(tmpdir(), 'korn-edit-')), 'conflict.md');
	writeFileSync(tmp, start);
	const editor = process.env.VISUAL || process.env.EDITOR || 'nano';
	const result = spawnSync(editor, [tmp], { stdio: 'inherit', shell: true });
	const text = result.status === 0 ? readFileSync(tmp, 'utf8') : undefined;
	rmSync(path.dirname(tmp), { recursive: true, force: true });
	return text;
}

// Show each conflict with 2 lines around it and ask: m / t / b / B / e / q
async function pickInteractive(file: string, segments: Segment[]): Promise<Choice[] | undefined> {
	if (!process.stdin.isTTY) {
		throw new Error(`ต้องรันใน terminal หรือใส่ --mine | --theirs | --copy`);
	}
	const color = (code: number, text: string) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
	const block = (text: string) => (text ? text.replace(/\n$/, '').split('\n').map((l) => `    ${l}`).join('\n') : '    (ว่าง)');
	const lines = (text: string) => text.replace(/\n$/, '').split('\n');
	const total = segments.filter((s) => s.kind === 'conflict').length;
	const picks: Choice[] = [];
	let n = 0;
	for (const [i, c] of segments.entries()) {
		if (c.kind !== 'conflict') {
			continue;
		}
		n++;
		console.log(`\n${color(1, `${file} — จุดที่ ${n} จาก ${total}`)}`);
		const textOf = (seg: Segment | undefined) => (seg?.kind === 'text' ? seg.text : '');
		const before = lines(textOf(segments[i - 1])).slice(-2);
		const after = lines(textOf(segments[i + 1])).slice(0, 2);
		before.filter(Boolean).forEach((l) => console.log(color(2, `    ${l}`)));
		console.log(color(32, '  [m] ของเรา:'));
		console.log(color(32, block(c.mine)));
		console.log(color(34, '  [t] ของอีกคน:'));
		console.log(color(34, block(c.theirs)));
		after.filter(Boolean).forEach((l) => console.log(color(2, `    ${l}`)));
		for (;;) {
			const answer = await ask('  เลือก m = ของเรา · t = ของอีกคน · b = ทั้งคู่ (เราก่อน) · B = ทั้งคู่ (อีกคนก่อน) · e = พิมพ์เอง · q = ยกเลิก > ');
			if (answer === 'q') {
				return undefined;
			}
			if (answer === 'e') {
				const text = editInEditor(c.mine + c.theirs);
				if (text !== undefined) {
					picks.push({ type: 'edit', text });
					break;
				}
				continue;
			}
			const type = ({ m: 'mine', t: 'theirs', b: 'mineFirst', B: 'theirsFirst' } as const)[answer as 'm' | 't' | 'b' | 'B'];
			if (type) {
				picks.push({ type });
				break;
			}
		}
	}
	return picks;
}

// ---- doctor ----

async function doctor(): Promise<number> {
	let problems = 0;
	const ok = (message: string) => console.log(`✓ ${message}`);
	const bad = (message: string) => {
		problems++;
		console.log(`✗ ${message}`);
	};

	try {
		ok(execFileSync('git', ['--version'], { encoding: 'utf8' }).trim());
	} catch {
		bad('ไม่พบ git ใน PATH');
	}
	ok(`node ${process.version}`);
	if (process.platform === 'darwin' || process.platform === 'linux') {
		process.env.SSH_AUTH_SOCK ? ok('ssh agent (SSH_AUTH_SOCK)') : console.log('- ไม่มี SSH_AUTH_SOCK (ถ้า push ผ่าน ssh key ที่มี passphrase อาจ push ไม่ได้)');
	}
	let config: Config | undefined;
	try {
		config = loadConfig();
		ok(`config ${configPath()} (${config.repos.length} repo)`);
	} catch (error) {
		bad((error as Error).message);
	}
	const pid = daemonPid();
	pid ? ok(`daemon ทำงานอยู่ (pid ${pid})`) : console.log('- sync เบื้องหลังยังไม่ทำงาน: korn start');

	for (const repo of config?.repos ?? []) {
		const name = tilde(repo.path);
		if (!existsSync(repo.path) || !statSync(repo.path).isDirectory()) {
			bad(`${name}: ไม่พบโฟลเดอร์`);
			continue;
		}
		try {
			await runGit(['rev-parse', '--show-toplevel'], repo.path);
		} catch {
			bad(`${name}: ไม่ใช่ git repo`);
			continue;
		}
		const remote = (await runGit(['remote'], repo.path)).trim().split('\n')[0];
		if (!remote) {
			bad(`${name}: ไม่มี remote (git remote add origin <url>)`);
			continue;
		}
		try {
			await runGit(['ls-remote', '--heads', remote], repo.path);
			ok(`${name}: เชื่อมต่อ ${remote} ได้`);
		} catch (error) {
			bad(`${name}: ต่อ ${remote} ไม่ได้ — ${(error as Error).message.split('\n')[0]}`);
		}
		try {
			await runGit(['config', 'user.email'], repo.path);
		} catch {
			bad(`${name}: ยังไม่ได้ตั้ง git user.email (git config --global user.email you@example.com)`);
		}
	}
	console.log(problems ? `\nพบ ${problems} ปัญหา` : '\nพร้อมใช้งาน');
	return problems ? 1 : 0;
}

main(process.argv.slice(2)).then(
	(code) => {
		// a running daemon keeps the process alive; everything else exits with its code
		if (process.argv[2] !== 'daemon' || code !== 0) {
			process.exit(code);
		}
	},
	(error) => {
		console.error(error instanceof ConfigError || error instanceof Error ? `korn: ${error.message}` : error);
		process.exit(1);
	}
);
