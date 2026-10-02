import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import * as path from 'path';
import picomatch from 'picomatch';
import { isMap, isSeq, LineCounter, parseDocument, YAMLMap } from 'yaml';

// ~/.config/korn/config.yaml: which repos the daemon syncs and how (see docs/daemon.md)

// resolve = like the extension's "Resolve in Korn": leave conflict markers to pick per conflict
// (Korn's Resolve tab in VS Code, or `korn resolve <file>` in a terminal)
export type Policy = 'saveCopy' | 'keepMine' | 'keepTheirs' | 'pause' | 'resolve';
export const POLICIES: Policy[] = ['saveCopy', 'keepMine', 'keepTheirs', 'pause', 'resolve'];

export interface Rule {
	match: string;
	conflict?: Policy;
	quietMinutes?: number;
}

export interface RepoConfig {
	path: string; // absolute, ~ expanded
	include: string[];
	exclude: string[];
	quietMinutes: number;
	pullEveryMinutes: number;
	conflict: Policy;
	rules: Rule[];
}

// auto = conflicts in VS Code when it has the repo open, otherwise a dialog with "Open in VS Code"
export type NotifySetting = 'auto' | 'banner' | 'dialog' | 'off';
export const NOTIFY_SETTINGS: NotifySetting[] = ['auto', 'banner', 'dialog', 'off'];

// Where "เลือกเลย" opens a conflict: VS Code (Resolve tab) or a Terminal running `korn resolve`.
// auto = VS Code when it's installed
export type OpenSetting = 'auto' | 'vscode' | 'terminal';
export const OPEN_SETTINGS: OpenSetting[] = ['auto', 'vscode', 'terminal'];

export interface Config {
	repos: RepoConfig[];
	notify: NotifySetting;
	open: OpenSetting;
}

export const DEFAULTS = {
	include: ['**/*.md'],
	exclude: [] as string[],
	quietMinutes: 5,
	pullEveryMinutes: 10,
	conflict: 'saveCopy' as Policy,
};

// KORN_CONFIG / KORN_STATE_DIR override the locations (tests, several setups)
export function configPath(): string {
	return process.env.KORN_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'korn', 'config.yaml');
}

// shared with the extension, which writes its heartbeat there (src/shared/daemonBridge.ts)
export { stateDir } from '../src/shared/daemonBridge';

export function expandHome(p: string): string {
	return p === '~' || p.startsWith('~/') ? path.join(homedir(), p.slice(1)) : p;
}

export class ConfigError extends Error {}

/** Parse and check config text. Errors name the field and its line: "line 4: repos[0].conflict: …" */
export function parseConfig(text: string): Config {
	const lines = new LineCounter();
	const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
	if (doc.errors.length > 0) {
		const e = doc.errors[0];
		throw new ConfigError(`line ${lines.linePos(e.pos[0]).line}: ${e.message.split('\n')[0]}`);
	}
	const fail = (at: (string | number)[], message: string): never => {
		// the field itself, or the nearest parent that exists (a missing field points at its repo)
		let node: { range?: [number, number] } | undefined;
		for (let n = at.length; n > 0 && !node?.range; n--) {
			node = doc.getIn(at.slice(0, n), true) as typeof node;
		}
		const where = node?.range ? `line ${lines.linePos(node.range[0]).line}: ` : '';
		const name = at.map((k, i) => (typeof k === 'number' ? `[${k}]` : i === 0 ? k : `.${k}`)).join('');
		throw new ConfigError(`${where}${name}: ${message}`);
	};

	const root = doc.toJS() ?? {};
	if (typeof root !== 'object' || Array.isArray(root)) {
		fail([], 'ต้องเป็น key: value');
	}
	const known = ['repos', 'notify', 'open'];
	for (const key of Object.keys(root)) {
		if (!known.includes(key)) {
			fail([key], `ไม่รู้จัก (ใช้ได้: ${known.join(', ')})`);
		}
	}
	if (root.repos !== undefined && root.repos !== null && !Array.isArray(root.repos)) {
		fail(['repos'], 'ต้องเป็นรายการ (- path: …)');
	}

	const minutes = (at: (string | number)[], value: unknown, fallback: number): number => {
		if (value === undefined) {
			return fallback;
		}
		if (typeof value !== 'number' || value < 0) {
			fail(at, 'ต้องเป็นตัวเลขนาทีตั้งแต่ 0 ขึ้นไป');
		}
		return value as number;
	};
	const policy = (at: (string | number)[], value: unknown, fallback: Policy): Policy => {
		if (value === undefined) {
			return fallback;
		}
		if (!POLICIES.includes(value as Policy)) {
			fail(at, `ต้องเป็น ${POLICIES.join(' | ')}`);
		}
		return value as Policy;
	};
	const globs = (at: (string | number)[], value: unknown, fallback: string[]): string[] => {
		if (value === undefined) {
			return fallback;
		}
		const list = typeof value === 'string' ? [value] : value;
		if (!Array.isArray(list) || list.some((g) => typeof g !== 'string')) {
			fail(at, 'ต้องเป็น pattern หรือรายการ pattern เช่น ["**/*.md"]');
		}
		return list as string[];
	};

	const repoKeys = ['path', 'include', 'exclude', 'quietMinutes', 'pullEveryMinutes', 'conflict', 'rules'];
	const repos: RepoConfig[] = ((root.repos ?? []) as Record<string, unknown>[]).map((r, i) => {
		const at = (...rest: (string | number)[]) => ['repos', i, ...rest];
		if (!r || typeof r !== 'object' || Array.isArray(r)) {
			fail(at(), 'ต้องเป็น key: value (อย่างน้อยมี path)');
		}
		for (const key of Object.keys(r)) {
			if (!repoKeys.includes(key)) {
				fail(at(key), `ไม่รู้จัก (ใช้ได้: ${repoKeys.join(', ')})`);
			}
		}
		if (typeof r.path !== 'string' || !r.path.trim()) {
			fail(at('path'), 'ต้องระบุ path ของ repo');
		}
		if (r.rules !== undefined && !Array.isArray(r.rules)) {
			fail(at('rules'), 'ต้องเป็นรายการ (- match: …)');
		}
		const rules = ((r.rules ?? []) as Record<string, unknown>[]).map((rule, j): Rule => {
			if (!rule || typeof rule.match !== 'string') {
				fail(at('rules', j, 'match'), 'ต้องระบุ match เช่น "journal/*.md"');
			}
			for (const key of Object.keys(rule)) {
				if (!['match', 'conflict', 'quietMinutes'].includes(key)) {
					fail(at('rules', j, key), 'ไม่รู้จัก (ใช้ได้: match, conflict, quietMinutes)');
				}
			}
			return {
				match: rule.match as string,
				conflict: rule.conflict === undefined ? undefined : policy(at('rules', j, 'conflict'), rule.conflict, DEFAULTS.conflict),
				quietMinutes:
					rule.quietMinutes === undefined ? undefined : minutes(at('rules', j, 'quietMinutes'), rule.quietMinutes, 0),
			};
		});
		return {
			path: path.resolve(expandHome((r.path as string).trim())),
			include: globs(at('include'), r.include, DEFAULTS.include),
			exclude: globs(at('exclude'), r.exclude, DEFAULTS.exclude),
			quietMinutes: minutes(at('quietMinutes'), r.quietMinutes, DEFAULTS.quietMinutes),
			pullEveryMinutes: minutes(at('pullEveryMinutes'), r.pullEveryMinutes, DEFAULTS.pullEveryMinutes),
			conflict: policy(at('conflict'), r.conflict, DEFAULTS.conflict),
			rules,
		};
	});

	// true / false from older configs = auto / off
	const notify: unknown = root.notify === undefined || root.notify === true ? 'auto' : root.notify === false ? 'off' : root.notify;
	if (!NOTIFY_SETTINGS.includes(notify as NotifySetting)) {
		fail(['notify'], `ต้องเป็น ${NOTIFY_SETTINGS.join(' | ')}`);
	}
	const open = root.open ?? 'auto';
	if (!OPEN_SETTINGS.includes(open)) {
		fail(['open'], `ต้องเป็น ${OPEN_SETTINGS.join(' | ')}`);
	}
	return { repos, notify: notify as NotifySetting, open };
}

export function loadConfig(file = configPath()): Config {
	if (!existsSync(file)) {
		throw new ConfigError(`ไม่พบ ${file} — รัน "korn init" ก่อน`);
	}
	try {
		return parseConfig(readFileSync(file, 'utf8'));
	} catch (error) {
		if (error instanceof ConfigError) {
			throw new ConfigError(`${file} ${error.message}`);
		}
		throw error;
	}
}

// ---- Per-file settings ----

/** Does this repo sync `file` (repo-relative, "/" separated)? */
export function isIncluded(repo: RepoConfig, file: string): boolean {
	return picomatch.isMatch(file, repo.include, { dot: false }) && !picomatch.isMatch(file, repo.exclude);
}

/** The first rule that matches wins, then the repo setting */
export function settingsFor(repo: RepoConfig, file: string): { conflict: Policy; quietMinutes: number } {
	const rule = repo.rules.find((r) => picomatch.isMatch(file, r.match));
	return {
		conflict: rule?.conflict ?? repo.conflict,
		quietMinutes: rule?.quietMinutes ?? repo.quietMinutes,
	};
}

// ---- Writing the file (korn init / add / remove), keeping the user's comments ----

export const TEMPLATE = `# Korn daemon — sync markdown notes through git in the background.
# Changes are picked up by the running daemon without a restart.
# Docs: https://github.com/midnightzkkornz/korn-extension/blob/main/docs/daemon.md

#
# Each repo (only path is required, the rest shows the defaults):
#  - path: ~/notes/fellowbook       # a git repo with a remote
#    include: ["**/*.md"]           # files to sync
#    exclude: ["drafts/**"]
#    quietMinutes: 5                # commit once a file hasn't changed for 5 minutes (0 = right away)
#    pullEveryMinutes: 10           # get what others pushed (0 = never)
#    conflict: saveCopy             # saveCopy | keepMine | keepTheirs | pause | resolve
#                                   #   resolve = pick per conflict in VS Code (Korn → Resolve) or "korn resolve <file>"
#    rules:                         # per-file settings, first match wins
#      - match: "journal/*.md"
#        conflict: keepMine
#
# notify: how conflicts and errors are shown
#   auto   = conflicts in VS Code when it has the repo open, otherwise a dialog with "Open in VS Code"
#   banner = a notification banner · dialog = always the dialog · off = nothing (see korn status)

notify: auto
# open: where "เลือกเลย" opens a conflict — auto (VS Code if installed) | vscode | terminal (korn resolve)
open: auto
repos: []
`;

export function initConfig(file = configPath()): boolean {
	if (existsSync(file)) {
		return false;
	}
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, TEMPLATE);
	return true;
}

/** Set a top-level setting (korn setup), keeping comments */
export function setTopLevel(key: 'open' | 'notify', value: string, file = configPath()) {
	editConfig(file, (_repos, doc) => doc.set(key, value));
}

function editConfig(file: string, edit: (repos: YAMLMap[], doc: ReturnType<typeof parseDocument>) => void) {
	const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : TEMPLATE);
	let repos = doc.get('repos', true);
	if (!isSeq(repos)) {
		doc.set('repos', doc.createNode([]));
		repos = doc.get('repos', true);
	}
	if (isSeq(repos)) {
		repos.flow = false;
		edit(repos.items.filter(isMap) as YAMLMap[], doc);
	}
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, doc.toString());
	parseConfig(readFileSync(file, 'utf8')); // make sure the result is still valid
}

/** Add a repo with default settings. Returns false if it's already there. */
export function addRepo(repoPath: string, file = configPath()): boolean {
	let added = false;
	editConfig(file, (repos, doc) => {
		const exists = repos.some((r) => path.resolve(expandHome(String(r.get('path')))) === repoPath);
		if (!exists) {
			doc.addIn(['repos'], doc.createNode({ path: repoPath.replace(homedir(), '~') }));
			added = true;
		}
	});
	return added;
}

export function removeRepo(repoPath: string, file = configPath()): boolean {
	let removed = false;
	editConfig(file, (_repos, doc) => {
		const seq = doc.get('repos', true);
		if (isSeq(seq)) {
			const before = seq.items.length;
			seq.items = seq.items.filter((r) => !(isMap(r) && path.resolve(expandHome(String(r.get('path')))) === repoPath));
			removed = seq.items.length < before;
		}
	});
	return removed;
}

// ---- Presets: the few plain choices shown in VS Code and `korn setup` ----

/** "When both sides changed the same lines" */
export type ConflictPreset = 'keepBoth' | 'ask' | 'mine';
export const CONFLICT_PRESETS: Record<ConflictPreset, Policy> = { keepBoth: 'saveCopy', ask: 'resolve', mine: 'keepMine' };

/** How often: wait for a file to be quiet / get what others pushed (minutes) */
export type FrequencyPreset = 'fast' | 'normal' | 'relaxed';
export const FREQUENCY_PRESETS: Record<FrequencyPreset, { quietMinutes: number; pullEveryMinutes: number }> = {
	fast: { quietMinutes: 1, pullEveryMinutes: 2 },
	normal: { quietMinutes: 5, pullEveryMinutes: 10 },
	relaxed: { quietMinutes: 15, pullEveryMinutes: 30 },
};

/** The presets a repo's settings match ("custom" = set by hand in the yaml) */
export function presetOf(repo: RepoConfig): { conflict: ConflictPreset | 'custom'; frequency: FrequencyPreset | 'custom' } {
	const conflict = (Object.keys(CONFLICT_PRESETS) as ConflictPreset[]).find((k) => CONFLICT_PRESETS[k] === repo.conflict);
	const frequency = (Object.keys(FREQUENCY_PRESETS) as FrequencyPreset[]).find(
		(k) => FREQUENCY_PRESETS[k].quietMinutes === repo.quietMinutes && FREQUENCY_PRESETS[k].pullEveryMinutes === repo.pullEveryMinutes
	);
	return { conflict: conflict ?? 'custom', frequency: frequency ?? 'custom' };
}

/** Apply presets to a repo in the config file (keeps comments and other settings). Adds the repo if missing. */
export function setRepoOptions(
	repoPath: string,
	options: { conflict?: ConflictPreset; frequency?: FrequencyPreset },
	file = configPath()
) {
	addRepo(repoPath, file);
	editConfig(file, (repos) => {
		const repo = repos.find((r) => path.resolve(expandHome(String(r.get('path')))) === repoPath);
		if (!repo) {
			return;
		}
		if (options.conflict) {
			repo.set('conflict', CONFLICT_PRESETS[options.conflict]);
		}
		if (options.frequency) {
			repo.set('quietMinutes', FREQUENCY_PRESETS[options.frequency].quietMinutes);
			repo.set('pullEveryMinutes', FREQUENCY_PRESETS[options.frequency].pullEveryMinutes);
		}
	});
}
