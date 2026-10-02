# Background sync (korn)

Korn can keep syncing your notes after VS Code is closed. A small background program (`korn`) commits your changes once you stop typing, gets what others pushed, and handles the case where someone else edited the same lines.

> ภาษาไทยอยู่ด้านล่าง ↓

## Turn it on

**In VS Code:** open the **Korn Sync** panel and tick **Sync เบื้องหลัง** (background sync). That's it: it uses the repos of your workspace, and keeps running after VS Code closes and after a restart. Nothing else to install.

**In a terminal** (needs Node.js 18+, or Homebrew installs it):

```sh
npm install -g korn-sync          # or: pnpm add -g korn-sync (first time: pnpm setup) · yarn global add korn-sync · bun add -g korn-sync
korn setup
```

or with Homebrew (the formula lives in this repo):

```sh
brew tap midnightzkkornz/korn https://github.com/midnightzkkornz/korn-extension
brew install korn
korn setup
```

`korn setup` asks a few questions (which folder, what to do when edits collide, how often) and starts it.

### Terminal only (no VS Code)

Everything works from a terminal, with any editor (or none):

- `korn` shows the status; when a collision waits for you it asks **"เลือกตอนนี้เลยไหม?"** and walks you through it right there.
- `korn resolve` (from any folder) shows each collision with the lines around it: `m` mine · `t` theirs · `b` / `B` both · `e` type it yourself in `$EDITOR` (nano by default). Then it pushes.
- The notification's **เลือกเลย** button opens a Terminal window running `korn resolve` for that file.
- Or open the file in any editor and remove the `<<<<<<<` / `=======` / `>>>>>>>` markers yourself: korn finishes the merge once the file is quiet.

Where **เลือกเลย** opens is the `open:` setting: `auto` (default: VS Code if it's installed, otherwise Terminal), `vscode` or `terminal`. `korn setup` asks when it finds VS Code.

## Two choices

| | Options |
|---|---|
| **When both edited the same lines** | **Keep both** (default): the file takes their version, yours is saved next to it as `note.conflict-20261001-1641.r.md`. Nothing to do. · **Ask me**: you pick per conflict in Korn's Resolve tab. · **Use mine** |
| **How often** | **Fast**: syncs 1 minute after you stop typing, gets others' changes every 2 minutes · **Normal** (default): 5 / 10 · **Relaxed**: 15 / 30 |

Change them in the panel (VS Code) or with `korn setup` / `korn set . --conflict ask --frequency fast`.

## Day to day

- **See how it's doing:** the panel, or type `korn`. It always says what to do next when something needs you.
- **"Ask me" and someone edited the same lines:** a notification with **เลือกเลย** (pick now) opens the file in Korn's Resolve tab: pick per conflict, then **Finish & Sync**. In a terminal: `korn resolve note.r.md`.
- **"Keep both":** nothing to do; the panel and `korn` show the copy that was made, with a link to open it.
- **Turn it off:** untick it in the panel, or `korn stop`. Your settings stay.

## Commands

| Command | |
|---|---|
| `korn` | Status, and what to do next |
| `korn setup` | Set up with a few questions, then start |
| `korn start` / `korn stop` | Background sync on / off (macOS LaunchAgent, Linux systemd user unit) |
| `korn resolve [file]` | Pick mine / theirs / both for each conflict |
| `korn log [-f]` | What it did |
| `korn help --all` | Every command (`set`, `add`, `remove`, `sync`, `status --json`, `doctor`, `pause`, `resume`, `daemon`…) |

In VS Code, `Korn: Install 'korn' Command in PATH` puts the bundled `korn` in `~/.local/bin` without installing anything else (needs Node.js).

**After upgrading** (`npm update -g korn-sync`, `brew upgrade korn`…), run `korn start` once so the background service uses the new version; `korn` reminds you. (VS Code does this by itself when the extension updates.)

---

## For those who want to fine-tune

Everything above is stored in `~/.config/korn/config.yaml`; the presets just set these values. You can edit it by hand; the running daemon picks up changes by itself, and mistakes are reported with the line (`korn` shows them).

```yaml
notify: auto                     # auto | dialog | banner | off
open: auto                       # auto | vscode | terminal — where "เลือกเลย" opens a conflict
repos:
  - path: ~/notes/fellowbook
    include: ["**/*.md"]
    exclude: ["drafts/**"]
    quietMinutes: 5              # commit once a file hasn't changed for N minutes (0 = right away)
    pullEveryMinutes: 10         # get what others pushed (0 = never)
    conflict: saveCopy           # saveCopy | keepMine | keepTheirs | pause | resolve
    rules:                       # per-file settings, first match wins
      - match: "journal/*.md"
        conflict: keepMine
        quietMinutes: 1
```

Presets: keep both = `saveCopy`, ask me = `resolve`, use mine = `keepMine`; fast = 1/2, normal = 5/10, relaxed = 15/30. Other values show as "custom" in the panel.

### How a round works

Every 30 seconds, for each repo:

1. **Skip the repo** if VS Code is syncing it, a merge or rebase is in progress, HEAD is detached, or a conflict is waiting for you.
2. **Commit** each changed file that matches `include`/`exclude`, has no conflict markers, and hasn't changed for `quietMinutes`. One commit per file: `update notes.md - 2026-09-30 10:12`. Nothing else is staged.
3. **Fetch** when there's something to push or it's time to pull.
4. **Rebase** onto the remote. Different lines merge by themselves. Same lines → the `conflict` setting:

   | Setting | Result |
   |---|---|
   | `saveCopy` | The file takes the remote version; ours goes to `note.conflict-….r.md` (`.md` files: `notes.conflict-….md`). A new copy each time. |
   | `keepMine` / `keepTheirs` | The file ends up as ours / as on the remote (the other stays in git history) |
   | `resolve` | Conflict markers; pick in VS Code's Resolve tab or `korn resolve <file>`. Removing the markers by hand works too (concluded once the file is quiet). Nothing is pushed for this repo meanwhile. |
   | `pause` | Nothing pushed until `korn resolve <file> --mine \| --theirs \| --copy` |

   A file still within its quiet time that the remote also changed waits until it's committed.
5. **Push** (a new branch is created on `origin`).

### Notifications (`notify:`)

| Setting | Conflict | Error |
|---|---|---|
| `auto` (default) | In VS Code when a window has the repo open; otherwise a macOS dialog (closes after 60 s) | Banner |
| `dialog` / `banner` / `off` | Always the dialog / a banner / nothing | Banner / banner / nothing |

Plain macOS banners come from `osascript` and open Script Editor when clicked, so conflicts use VS Code or the dialog. With `terminal-notifier` installed, banners use it and open the file. If macOS won't let a background job show the dialog, a banner is shown instead (see `korn log`).

### Releasing (npm + Homebrew)

One package on npm, `korn-sync`, serves npm, pnpm, yarn and bun. The Homebrew formula (`Formula/korn.rb`, in this repo so no separate tap repo is needed) downloads that same package from npm. A GitHub Actions workflow does both (`.github/workflows/korn-release.yml`).

One-time setup:

1. This repo must be **public** (`brew tap` clones it; npm provenance needs it).
2. On npmjs.com, create a **Granular Access Token** that can publish (read and write packages), and add it to this repo → Settings → Secrets and variables → Actions as `NPM_TOKEN`.

Each release:

1. Bump `daemon/version.ts` and commit.
2. `make korn-tag` prints `git tag korn-v<version> && git push origin korn-v<version>`; run it.
3. The workflow tests, publishes `korn-sync@<version>` to npm, then writes `Formula/korn.rb` (from `packaging/homebrew/korn.rb`, with the sha256 of the published tarball) and commits it to `main`. If `main` has branch protection that blocks GitHub Actions, that last step fails: allow it, or commit the formula by hand.

By hand instead: `npm login`, `make npm-publish`, `make brew-formula` (writes `Formula/korn.rb` from the published version), commit. `make npm-pack` shows what would be published; `make brew-formula-check` renders a formula from a local pack into `dist/`.

### With the VS Code extension

Both can run together. They share a lock (`.git/korn.lock`): the daemon skips a round while VS Code syncs, and VS Code's Sync waits up to 20 seconds for the daemon. VS Code tells the daemon which folders it has open with a heartbeat (`~/.local/state/korn/vscode/<pid>.json`), and the daemon sends conflicts to it through `~/.local/state/korn/events.jsonl`.

### Files

| Path | What |
|---|---|
| `~/.config/korn/config.yaml` | Settings (`KORN_CONFIG` overrides) |
| `~/.local/state/korn/` | `state.json` (last round per repo), `korn.log`, `events.jsonl`, `vscode/` heartbeats (`KORN_STATE_DIR` overrides) |
| `~/.local/share/korn/korn.js` | The copy the background service runs (`korn start` refreshes it) |
| `~/Library/LaunchAgents/com.midnightzkkornz.korn.plist` | The background service on macOS (`~/.config/systemd/user/korn.service` on Linux) |
| `<repo>/.git/korn.lock`, `<repo>/.git/korn-paused.json` | Lock while syncing; paused files |

### Code

| File | Role |
|---|---|
| `daemon/cli.ts` | Commands and the daemon loop |
| `daemon/setup.ts`, `daemon/overview.ts`, `daemon/messages.ts` | `korn setup`, `korn` / `status --json`, the sentences people see |
| `daemon/config.ts` | Config, presets (`setRepoOptions`), include/exclude/rules |
| `daemon/engine.ts` | One round (`runRound`), `korn resolve` (`resolvePaused`, `finishMergeResolve`) |
| `daemon/service.ts` | `korn start` / `stop`: LaunchAgent / systemd unit |
| `packaging/npm/`, `packaging/homebrew/`, `Formula/korn.rb` | The `korn-sync` npm package; the Homebrew formula template and its rendered copy |
| `daemon/notify.ts`, `daemon/state.ts` | Notifications; state.json, paused files, log, pid |
| `src/git/ops.ts`, `src/git/lock.ts`, `src/shared/daemonBridge.ts` | Shared with the extension: git steps, lock, heartbeat + events |
| `src/daemon/background.ts`, `webview/panel/components/BackgroundSync.tsx` | The panel section: runs the bundled `out/korn.js` |
| `test/daemon/`, `test/unit/daemon*.test.ts` | Tests (real git repos in a temp folder) |

Build: `npm run compile` also builds `out/korn.js` (shipped in the extension) and `dist/korn.js`. `make daemon-run` runs it in a terminal, `make korn-link` puts the dev build in `~/.local/bin`, `make npm-pack` / `make npm-publish` / `make brew-formula` publish (see Releasing).

---

## ภาษาไทย

Korn sync โน้ตต่อได้แม้ปิด VS Code: มีโปรแกรมเล็กๆ (`korn`) ทำงานเบื้องหลัง commit ให้เมื่อคุณหยุดพิมพ์ ดึงของที่คนอื่น push มา และจัดการตอนที่มีคนแก้บรรทัดเดียวกัน

### เปิดใช้

**ใน VS Code:** เปิดแผง **Korn Sync** แล้วติ๊ก **Sync เบื้องหลัง** จบ ใช้ repo ใน workspace ทำงานต่อแม้ปิด VS Code และตอนเปิดเครื่อง ไม่ต้องลงอะไรเพิ่ม

**ใน terminal** (ต้องมี Node.js 18 ขึ้นไป หรือใช้ brew ซึ่งลงให้เอง):

```sh
npm install -g korn-sync          # หรือ pnpm add -g korn-sync (ครั้งแรก pnpm setup) · yarn global add korn-sync · bun add -g korn-sync
korn setup
```

หรือใช้ Homebrew (สูตรอยู่ใน repo นี้):

```sh
brew tap midnightzkkornz/korn https://github.com/midnightzkkornz/korn-extension
brew install korn
korn setup
```

อัปเดตแล้ว (`npm update -g korn-sync`, `brew upgrade korn`) ให้พิมพ์ `korn start` ครั้งหนึ่ง เพื่อให้ตัวที่รันเบื้องหลังเป็นเวอร์ชันใหม่ (`korn` จะเตือนให้)

`korn setup` ถาม 3 ข้อ (โฟลเดอร์ไหน, ถ้าแก้ชนกันทำยังไง, บ่อยแค่ไหน) แล้วเริ่มทำงานให้เลย

### ตัวเลือก 2 อย่าง

- **เมื่อแก้ชนกัน:**
  - **เก็บทั้งสองไว้** (ค่าเริ่มต้น): ในไฟล์เป็นของอีกคน ของคุณเก็บเป็นไฟล์สำเนา `note.conflict-….r.md` ไม่ต้องทำอะไร
  - **ถามฉัน**: เลือกทีละจุดในแท็บ Resolve
  - **ใช้ของฉัน**
- **ความถี่:**
  - **เร็ว**: หยุดพิมพ์ 1 นาทีก็ sync, ดึงของคนอื่นทุก 2 นาที
  - **ปกติ** (ค่าเริ่มต้น): 5 / 10 นาที
  - **ประหยัด**: 15 / 30 นาที

เปลี่ยนได้ในแผงของ VS Code หรือ `korn setup`

### ใช้งานทุกวัน

- **ดูสถานะ:** ดูในแผง หรือพิมพ์ `korn` ถ้ามีอะไรต้องทำ มันจะบอกขั้นต่อไปเสมอ
- **แบบ "ถามฉัน" แล้วมีคนแก้บรรทัดเดียวกัน:** ขึ้นโน้ตมีปุ่ม **เลือกเลย** กดแล้วเปิดไฟล์ในแท็บ Resolve เลือกเสร็จกด Finish & Sync ส่วนใน terminal ใช้ `korn resolve note.r.md`
- **แบบ "เก็บทั้งสองไว้":** ไม่ต้องทำอะไร แผงและ `korn` บอกว่าสร้างสำเนาไว้ที่ไหน มีลิงก์ให้เปิดดู
- **ปิด:** เอาติ๊กออกในแผง หรือ `korn stop` การตั้งค่ายังอยู่

คำสั่ง: `korn` · `korn setup` · `korn start` / `korn stop` · `korn resolve [ไฟล์]` · `korn log` · `korn help --all`

### ใช้ใน terminal อย่างเดียว (ไม่มี VS Code)

- พิมพ์ `korn` ดูสถานะ ถ้ามีไฟล์ที่แก้ชนกันรออยู่ จะถาม **"เลือกตอนนี้เลยไหม?"** แล้วพาเลือกตรงนั้นเลย
- `korn resolve` (รันจากโฟลเดอร์ไหนก็ได้) โชว์ทีละจุดพร้อมบรรทัดรอบๆ: `m` ของเรา · `t` ของอีกคน · `b` / `B` ทั้งคู่ · `e` พิมพ์เองใน `$EDITOR` (ค่าเริ่มต้น nano) เสร็จแล้ว push ให้
- ปุ่ม **เลือกเลย** ในกล่องแจ้งเตือนจะเปิดหน้าต่าง Terminal ที่รัน `korn resolve` ให้
- หรือเปิดไฟล์ด้วยโปรแกรมไหนก็ได้ แล้วลบ marker `<<<<<<<` / `=======` / `>>>>>>>` เอง korn จะปิด merge ให้เมื่อไฟล์นิ่ง

ตั้งได้ว่า **เลือกเลย** เปิดที่ไหนด้วย `open:` ใน config: `auto` (มี VS Code ใช้ VS Code ไม่มีใช้ Terminal) / `vscode` / `terminal` ซึ่ง `korn setup` จะถามให้ถ้าเจอ VS Code ในเครื่อง

### ออกเวอร์ชันใหม่ (npm + brew)

แพ็กเกจเดียวบน npm ชื่อ `korn-sync` ใช้ได้ทั้ง npm, pnpm, yarn, bun ส่วนสูตร brew (`Formula/korn.rb` อยู่ใน repo นี้ ไม่ต้องมี repo tap แยก) ดาวน์โหลดแพ็กเกจเดียวกันจาก npm

ตั้งครั้งเดียว: repo นี้ต้องเป็น **public** แล้วสร้าง Granular Access Token บน npmjs.com ที่ publish ได้ ใส่เป็น secret `NPM_TOKEN` ใน repo นี้

ทุกครั้งที่ออกเวอร์ชัน: แก้ `daemon/version.ts` → commit → `make korn-tag` จะพิมพ์คำสั่ง `git tag … && git push …` ให้ รันแล้ว GitHub Actions จะ test → publish ขึ้น npm → เขียน `Formula/korn.rb` แล้ว commit เข้า `main` ให้เอง

ทำเองจากเครื่องก็ได้: `npm login` → `make npm-publish` → `make brew-formula` → commit

ใน VS Code มีคำสั่ง `Korn: Install 'korn' Command in PATH` ใส่คำสั่ง `korn` ให้ใช้ใน terminal ได้โดยไม่ต้องติดตั้งอะไรเพิ่ม (ต้องมี Node.js)

ตั้งค่าละเอียด (include/exclude, rules, notify) ดูหัวข้อ "For those who want to fine-tune" ด้านบน
