import type { ConflictAction, ConflictItem } from '../../../src/shared/protocol';
import { CONFLICT_ACTIONS, RESOLVING_ACTIONS } from '../labels';

interface Props {
	item: ConflictItem;
	onChoose: (action: ConflictAction) => void;
}

// "⚠ Conflict" card: shown only while a Sync hit a real conflict
export function ConflictCard({ item, onChoose }: Props) {
	const hint = item.busy
		? 'กำลังจัดการ…'
		: item.resolving
			? 'กำลังแก้ในแท็บ ⚠ Resolve'
			: 'ไฟล์นี้ถูกแก้บน remote ด้วย เลือกวิธีจัดการ:';

	return (
		<div class="conflict">
			<h3>⚠ Conflict</h3>
			<div class="file">{item.name}</div>
			<div class="hint">{hint}</div>
			{(item.resolving ? RESOLVING_ACTIONS : CONFLICT_ACTIONS).map(([action, label, primary]) => (
				<button
					key={action}
					class={primary ? '' : 'secondary'}
					disabled={item.busy} // one action at a time per file
					onClick={() => onChoose(action)}
				>
					{label}
				</button>
			))}
		</div>
	);
}
