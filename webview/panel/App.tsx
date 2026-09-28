import { useEffect, useState } from 'preact/hooks';
import type { ConflictItem, FileRow, HostToPanel, PanelToHost, RepoInfo } from '../../src/shared/protocol';
import { SyncIcon } from '../shared/SyncIcon';
import { createPoster, useHostMessage } from '../shared/vscode';
import { ConflictCard } from './components/ConflictCard';
import { FileList } from './components/FileList';
import { isPending, repoLine } from './labels';

const post = createPoster<PanelToHost>();

// Korn Sync side panel: Sync all, auto-sync status, conflict cards, every .r.md with its state
export function App() {
	const [conflicts, setConflicts] = useState<ConflictItem[]>([]);
	const [files, setFiles] = useState<FileRow[]>();
	const [repos, setRepos] = useState<RepoInfo[]>([]);
	const [autoSync, setAutoSync] = useState('Auto-sync: …');

	useHostMessage<HostToPanel>((message) => {
		switch (message.type) {
			case 'conflicts':
				setConflicts(message.items);
				break;
			case 'files':
				setFiles(message.files);
				setRepos(message.repos);
				setAutoSync(message.autoSync);
				break;
		}
	});

	useEffect(() => post({ type: 'ready' }), []);

	const detachedRoots = new Set(repos.filter((r) => r.detached).map((r) => r.root));
	const pending = files?.filter((f) => isPending(f) && !(f.root && detachedRoots.has(f.root))).length ?? 0;

	return (
		<>
			<button
				id="syncAll"
				disabled={pending === 0}
				title={pending ? 'ส่งของเราและดึงของใหม่จาก remote ทั้งหมด' : 'ทุกไฟล์ sync แล้ว'}
				onClick={() => post({ type: 'syncAll' })}
			>
				<SyncIcon />
				<span>{pending ? `Sync all (${pending})` : 'Sync all'}</span>
			</button>

			<div class="auto-line">
				<button class="auto" title="เปิด Settings ของ auto-sync" onClick={() => post({ type: 'openSettings' })}>
					{autoSync}
				</button>
				<button
					class="auto"
					title="Output → Korn: สิ่งที่ auto-sync ทำ และเหตุผลที่ข้าม"
					onClick={() => post({ type: 'showLog' })}
				>
					log
				</button>
			</div>

			{conflicts.map((item) => (
				<ConflictCard key={item.uri} item={item} onChoose={(action) => post({ type: 'resolve', uri: item.uri, action })} />
			))}

			<div class="section">FILES</div>
			{repos.map((repo) => {
				const line = repoLine(repo);
				return (
					<div key={repo.root} class={`repo repo-${line.kind}`} title={repo.root}>
						{repos.length > 1 && <span class="repo-name">{repo.name}</span>}
						{line.text}
					</div>
				);
			})}
			<FileList
				files={files}
				detachedRoots={detachedRoots}
				onOpen={(uri) => post({ type: 'open', uri })}
				onSync={(uri) => post({ type: 'syncFile', uri })}
			/>
		</>
	);
}
