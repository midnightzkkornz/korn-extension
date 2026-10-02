import type { BackgroundRepo, BackgroundView, ConflictPreset, FrequencyPreset, PanelToHost } from '../../../src/shared/protocol';
import { formatTime } from '../labels';

const CONFLICT_LABELS: Record<ConflictPreset, string> = {
	keepBoth: 'เก็บทั้งสองไว้',
	ask: 'ถามฉัน',
	mine: 'ใช้ของฉัน',
};
const CONFLICT_HINTS: Record<ConflictPreset, string> = {
	keepBoth: 'ในไฟล์เป็นของอีกคน ของคุณเก็บเป็นไฟล์สำเนา — ไม่ต้องทำอะไร',
	ask: 'เลือกทีละจุดในแท็บ Resolve',
	mine: 'ใช้ของคุณทับ (ของอีกคนยังอยู่ใน git history)',
};
const FREQUENCY_LABELS: Record<FrequencyPreset, string> = {
	fast: 'เร็ว (1 นาที)',
	normal: 'ปกติ (5 นาที)',
	relaxed: 'ประหยัด (15 นาที)',
};

interface Props {
	view?: BackgroundView;
	post: (message: PanelToHost) => void;
}

// "Background sync": the korn daemon, which keeps syncing after VS Code is closed
export function BackgroundSync({ view, post }: Props) {
	if (!view?.supported) {
		return null;
	}
	const status = view.busy
		? 'กำลังตั้งค่า…'
		: view.on
			? view.running
				? 'ทำงานอยู่ แม้ปิด VS Code'
				: 'เปิดไว้ แต่ยังไม่ทำงาน — ลองปิดแล้วเปิดใหม่'
			: 'ปิดอยู่ — sync เฉพาะตอนเปิด VS Code';

	return (
		<div class="bg">
			<label class="bg-switch" title="ทำงานต่อแม้ปิด VS Code และตอนเปิดเครื่อง">
				<input type="checkbox" checked={view.on} disabled={view.busy} onChange={(e) => post({ type: 'bgToggle', on: e.currentTarget.checked })} />
				<span>Sync เบื้องหลัง</span>
			</label>
			<div class={`bg-status ${view.on && !view.running && !view.busy ? 'warn' : ''}`}>{status}</div>
			{view.error && <div class="bg-problem">⚠ {view.error}</div>}
			{view.on && view.repos.map((repo) => <Repo key={repo.root} repo={repo} post={post} showName={view.repos.length > 1} />)}
			{view.on && (
				<button class="auto" onClick={() => post({ type: 'bgLog' })}>
					log
				</button>
			)}
		</div>
	);
}

function Repo({ repo, post, showName }: { repo: BackgroundRepo; post: Props['post']; showName: boolean }) {
	if (!repo.included) {
		return (
			<div class="bg-repo">
				{repo.name} ไม่ได้ sync เบื้องหลัง{' '}
				<button class="auto inline" onClick={() => post({ type: 'bgInclude', root: repo.root, included: true })}>
					เพิ่ม
				</button>
			</div>
		);
	}
	return (
		<div class="bg-repo">
			{showName && <div class="repo-name">{repo.name}</div>}
			<div class="bg-field">
				<span>ความถี่</span>
				<select
					value={repo.frequency}
					onChange={(e) => post({ type: 'bgSet', root: repo.root, frequency: e.currentTarget.value as FrequencyPreset })}
				>
					{repo.frequency === 'custom' && <option value="custom">กำหนดเอง</option>}
					{(Object.keys(FREQUENCY_LABELS) as FrequencyPreset[]).map((k) => (
						<option key={k} value={k}>
							{FREQUENCY_LABELS[k]}
						</option>
					))}
				</select>
			</div>
			<div class="bg-field">
				<span>เมื่อแก้ชนกัน</span>
				<select
					value={repo.conflict}
					title={repo.conflict === 'custom' ? 'ตั้งไว้ใน config.yaml' : CONFLICT_HINTS[repo.conflict]}
					onChange={(e) => post({ type: 'bgSet', root: repo.root, conflict: e.currentTarget.value as ConflictPreset })}
				>
					{repo.conflict === 'custom' && <option value="custom">กำหนดเอง</option>}
					{(Object.keys(CONFLICT_LABELS) as ConflictPreset[]).map((k) => (
						<option key={k} value={k} title={CONFLICT_HINTS[k]}>
							{CONFLICT_LABELS[k]}
						</option>
					))}
				</select>
			</div>
			{repo.needsChoice.map((c) => (
				<div key={c.path} class="bg-choice">
					<span>⚠ {c.file} ต้องเลือก</span>
					<button onClick={() => post({ type: 'bgOpen', path: c.path })}>เลือกเลย</button>
				</div>
			))}
			<div class="bg-line">
				✓ sync ล่าสุด {repo.lastSync ? formatTime(repo.lastSync) : 'ยังไม่เคย'}
				{repo.waiting > 0 && ` · ⏳ รอ ${repo.waiting} ไฟล์`}
			</div>
			{repo.notices.map((n) => (
				<div key={n.file + n.message} class="bg-line">
					ℹ {n.message.replace(`${repo.name}: `, '')}{' '}
					<button class="auto inline" onClick={() => post({ type: 'bgOpen', path: n.file })}>
						เปิดดู
					</button>
				</div>
			))}
			{repo.problem && <div class="bg-problem">⚠ {repo.problem}</div>}
		</div>
	);
}
