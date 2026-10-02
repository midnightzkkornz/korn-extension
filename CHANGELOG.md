# Changelog

## 0.1.1

- Images with relative paths (`![](img.png)`) now show in View, Preview, Editor and the Resolve preview
- Editor (WYSIWYG) mode no longer restyles the whole file: only the lines you edit change, the rest keeps its exact formatting (list bullets, `__bold__`, setext headings, blank lines…), and edited list items use the file's bullet style
- `#heading` links scroll within the page
- Keyboard shortcuts: switch mode (`⌃⌘1`–`4`, `⌃⌘M`), insert date & time (`⌃⌘T`), open a note (`⌃⌘O`), new note (`⌃⌘N`), show the panel (`⌃⌘K`)
- Resolve tab keys: `↑` `↓` pick a conflict, `M` / `T` / `B` / `⇧B` / `E` / `U` choose, `⌘Enter` Finish & Sync
- New commands: `Korn: Show Mode…`, `Korn: Insert Date & Time`, `Korn: Open Note…`
- Background sync: tick **Sync เบื้องหลัง** in the panel to keep syncing after VS Code closes (the bundled `korn` daemon; also `brew install` + `korn setup` without VS Code). Plain choices for collisions (keep both / ask me / use mine) and frequency; conflicts open straight in the Resolve tab. See docs/daemon.md

## 0.1.0

First release.

- `.r.md` editor with an always-visible toolbar and 4 modes: View, Text, Preview, Editor (WYSIWYG)
- Rendered markdown uses VS Code's own Markdown Preview styles
- Sync: commit only the current file, integrate remote changes, push (through VS Code's Git login)
- Conflicts: automatic merge for different lines; for the same lines choose Replace with my version, Save my work as copy, or Resolve in Korn (per-conflict choices, three-way highlights, result preview, Finish & Sync); cancel or switch options at any time
- Korn Sync side panel: every `.r.md` with its sync state, Sync all, conflict cards, branch per repo
- Auto-sync on save and/or every N minutes, including pulling others' changes safely
- Branch aware: syncs the checked-out branch, creates the remote branch on first sync, clears stale state on branch switch, refuses to sync in detached HEAD
- Output → Korn log of what auto-sync did
