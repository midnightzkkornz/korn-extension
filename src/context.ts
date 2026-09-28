import type { AutoSync } from './sync/autoSync';
import type { ConflictStore } from './state/conflicts';
import type { SyncViewProvider } from './views/panelProvider';

// The long-lived objects the commands share. Filled once in activate() (src/extension.ts).
export interface KornContext {
	conflicts: ConflictStore;
	panel: SyncViewProvider;
	autoSync: AutoSync;
}

export const ctx = {} as KornContext;
