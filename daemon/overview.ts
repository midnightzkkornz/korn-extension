import { existsSync } from 'fs';
import * as path from 'path';
import { formatDate, pendingMerge } from '../src/git/ops';
import { Config, ConfigError, configPath, ConflictPreset, FrequencyPreset, loadConfig, presetOf } from './config';
import { nextStep } from './messages';
import { openMode } from './opener';
import { serviceInstalled, serviceRuntime } from './service';
import { daemonPid, daemonVersion, readPaused, readState } from './state';
import { VERSION } from './version';

// What `korn` (no arguments), `korn status --json` and the VS Code panel show: one shape for all.

export interface RepoOverview {
	path: string;
	name: string;
	branch?: string;
	upstream?: string;
	lastSync?: string;
	conflict: ConflictPreset | 'custom';
	frequency: FrequencyPreset | 'custom';
	waiting: { file: string; readyAt: string }[];
	/** files waiting for the user: "ask" = pick per conflict, "paused" = pick a side */
	needsChoice: { file: string; path: string; kind: 'ask' | 'paused'; next: string }[];
	notices: { time: string; message: string; file: string }[]; // recent, last 24 h
	problem?: string; // error, or why it's not syncing
}

export interface Overview {
	running: boolean; // the daemon process is alive
	warnings: string[]; // things to fix with `korn start` (old version still running, runtime gone)
	service: boolean; // starts at login (korn start)
	configPath: string;
	configured: boolean;
	configError?: string;
	repos: RepoOverview[];
}

export async function overview(): Promise<Overview> {
	const running = daemonPid() !== undefined;
	const warnings: string[] = [];
	const runtime = serviceRuntime();
	if (runtime && !existsSync(runtime)) {
		warnings.push(`โปรแกรมที่ใช้รัน sync เบื้องหลังหายไป (${runtime}) — พิมพ์: korn start`);
	}
	const runningVersion = daemonVersion();
	if (running && runningVersion && runningVersion !== VERSION) {
		warnings.push(`อัปเดตเป็น ${VERSION} แล้ว แต่เบื้องหลังยังรัน ${runningVersion} — พิมพ์: korn start เพื่อใช้เวอร์ชันใหม่`);
	}
	const base = { running, warnings, service: serviceInstalled(), configPath: configPath() };
	let config: Config;
	try {
		config = loadConfig();
	} catch (error) {
		const missing = !existsSync(configPath());
		return { ...base, configured: false, configError: missing ? undefined : (error as ConfigError).message, repos: [] };
	}
	const states = readState();
	const mode = openMode(config.open);
	const dayAgo = Date.now() - 24 * 60 * 60_000;
	const repos = await Promise.all(
		config.repos.map(async (repo): Promise<RepoOverview> => {
			const s = states[repo.path] ?? {};
			const needsChoice: RepoOverview['needsChoice'] = [];
			if (existsSync(repo.path)) {
				for (const file of (await pendingMerge(repo.path).catch(() => undefined)) ?? []) {
					needsChoice.push({ file, path: path.join(repo.path, file), kind: 'ask', next: nextStep.ask(file, mode) });
				}
				for (const [file, p] of Object.entries(await readPaused(repo.path).catch(() => ({})))) {
					if (p.reason === 'conflict') {
						needsChoice.push({ file, path: path.join(repo.path, file), kind: 'paused', next: nextStep.paused(file) });
					}
				}
			}
			const waitingForChoice = s.skipped?.startsWith('waiting for');
			return {
				path: repo.path,
				name: path.basename(repo.path),
				branch: s.branch,
				upstream: s.upstream,
				lastSync: s.lastSync,
				...presetOf(repo),
				waiting: s.waiting ?? [],
				needsChoice,
				notices: (s.notices ?? []).filter((n) => Date.parse(n.time) > dayAgo),
				problem: s.error ?? (waitingForChoice ? undefined : s.skipped),
			};
		})
	);
	return { ...base, configured: true, repos };
}

const time = (iso?: string) => (iso ? formatDate(new Date(iso)) : 'ยังไม่เคย');

/** Plain-language summary for `korn` with no arguments: always ends with what to do next, if anything */
export function describe(o: Overview): string {
	const lines: string[] = [];
	if (!o.configured) {
		if (o.configError) {
			return `⚠ ตั้งค่าผิด: ${o.configError}`;
		}
		return 'ยังไม่ได้ตั้งค่า — พิมพ์: korn setup';
	}
	if (o.repos.length === 0) {
		return 'ยังไม่มี repo — พิมพ์: korn setup';
	}
	lines.push(
		...o.warnings.map((w) => `⚠ ${w}`),
		o.running
			? '✓ sync เบื้องหลังทำงานอยู่'
			: o.service
				? '⚠ ตั้งให้ทำงานเบื้องหลังไว้ แต่ตอนนี้ไม่ได้ทำงาน — พิมพ์: korn start'
				: '○ sync เบื้องหลังปิดอยู่ — พิมพ์: korn start'
	);
	for (const r of o.repos) {
		lines.push('', `${r.name}  ${r.branch ? `⎇ ${r.branch}` : ''}  · sync ล่าสุด ${time(r.lastSync)}`);
		for (const c of r.needsChoice) {
			lines.push(`  ⚠ ${c.file} ถูกแก้ทั้งสองฝั่ง ต้องเลือก → ${c.next}`);
		}
		for (const w of r.waiting) {
			const minutes = Math.max(0, Math.ceil((Date.parse(w.readyAt) - Date.now()) / 60_000));
			lines.push(`  ⏳ ${w.file} จะ sync ในอีก ${minutes} นาที`);
		}
		for (const n of r.notices) {
			lines.push(`  ℹ ${formatDate(new Date(n.time))} ${n.message.replace(`${r.name}: `, '')}`);
		}
		if (r.problem) {
			lines.push(`  ⚠ ${r.problem}`);
		}
	}
	return lines.join('\n');
}
