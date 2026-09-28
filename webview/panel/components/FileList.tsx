import type { FileRow } from '../../../src/shared/protocol';
import { SyncIcon } from '../../shared/SyncIcon';
import { canSync, showsIncomingNote, stateLabel, syncTitle } from '../labels';

interface Props {
	files: FileRow[] | undefined; // undefined = not loaded yet
	onOpen: (uri: string) => void;
	onSync: (uri: string) => void;
}

export function FileList({ files, onOpen, onSync }: Props) {
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
				<FileRowView key={file.uri} file={file} onOpen={onOpen} onSync={onSync} />
			))}
		</ul>
	);
}

function FileRowView({ file, onOpen, onSync }: { file: FileRow } & Omit<Props, 'files'>) {
	const title = syncTitle(file);
	return (
		<li class="row">
			<span class="name" title={`เปิด ${file.name}`} onClick={() => onOpen(file.uri)}>
				{file.name}
			</span>
			<button class="sync" title={title} disabled={!canSync(file)} onClick={() => onSync(file.uri)}>
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
