# Changelog

## 0.1.1

- Images with relative paths (`![](img.png)`) now show in View, Preview, Editor and the Resolve preview
- Editor (WYSIWYG) mode no longer restyles the whole file: only the lines you edit change, the rest keeps its exact formatting (list bullets, `__bold__`, setext headings, blank lines…), and edited list items use the file's bullet style
- `#heading` links scroll within the page

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
