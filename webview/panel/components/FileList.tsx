import type { FileRow } from '../../../src/shared/protocol';
import { SyncIcon } from '../../shared/SyncIcon';
import { canSync, showsIncomingNote, stateLabel, syncTitle } from '../labels';

interface Props {
	files: FileRow[] | undefined; // undefined = not loaded yet
	detachedRoots: Set<string>; // repos in detached HEAD: nothing there can be synced
	onOpen: (uri: string) => void;
	onSync: (uri: string) => void;
}

export function FileList({ files, detachedRoots, onOpen, onSync }: Props) {
	if (!files) {
		return (
			<ul class="files">
				<li class="empty">กำลังโหลด…</li>
			</ul>
		);
	}
	if (files.length === 0) {
		return (
			<ul class="files">
				<li class="empty">ยังไม่มีไฟล์ .r.md — กดปุ่ม 📄 ด้านบนเพื่อสร้าง</li>
			</ul>
		);
	}
	return (
		<ul class="files">
			{files.map((file) => (
				<FileRowView
					key={file.uri}
					file={file}
					detached={!!file.root && detachedRoots.has(file.root)}
					onOpen={onOpen}
					onSync={onSync}
				/>
			))}
		</ul>
	);
}

interface RowProps {
	file: FileRow;
	detached: boolean;
	onOpen: (uri: string) => void;
	onSync: (uri: string) => void;
}

function FileRowView({ file, detached, onOpen, onSync }: RowProps) {
	const title = detached ? 'อยู่ใน detached HEAD — checkout branch ก่อนแล้วค่อย Sync' : syncTitle(file);
	return (
		<li class="row">
			<span class="name" title={`เปิด ${file.name}`} onClick={() => onOpen(file.uri)}>
				{file.name}
			</span>
			<button class="sync" title={title} disabled={!canSync(file, detached)} onClick={() => onSync(file.uri)}>
				<SyncIcon />
			</button>
			<span class="state" title={title}>
				{/* s- prefix so these never pick up the .conflict card styles */}
				<span class={`dot s-${file.state}`} />
				{stateLabel(file)}
				{showsIncomingNote(file) && <span class="incoming-note">· มีของใหม่บน remote</span>}
			</span>
		</li>
	);
}
