# korn-sync

Keep markdown notes in sync through git, in the background. `korn` commits a file once you stop typing, gets what others pushed, and handles the case where someone else edited the same lines. It keeps running after you close the terminal and after a restart.

It's the command-line side of [Korn Markdown Sync](https://github.com/midnightzkkornz/korn-extension) (a VS Code extension), and works on its own with any editor, or none.

## Install

```sh
npm install -g korn-sync
# or
pnpm add -g korn-sync        # first time with pnpm: pnpm setup
# or
brew tap midnightzkkornz/korn https://github.com/midnightzkkornz/korn-extension
brew install korn
```

Needs git, and Node.js 18+ (brew installs it). macOS and Linux.

## Use

```sh
korn setup     # which notes folder, what to do when edits collide, how often — then it starts
korn           # status, and what to do next if anything needs you
korn resolve   # pick yours / theirs / both for each collision
korn stop      # stop background sync (korn start to resume)
```

To remove it: `korn uninstall` first (stops the background service, asks whether to remove settings and logs), then `npm uninstall -g korn-sync`. Your notes are never touched.

When both of you edited the same lines, `korn setup` lets you choose:

- **Keep both** (default): the file takes their version, yours is saved next to it as `note.conflict-<time>.md`. Nothing to do.
- **Ask me**: `korn` (or the notification) walks you through each collision.
- **Use mine**

After upgrading (`npm update -g korn-sync`, `brew upgrade korn`), run `korn start` once so the background service uses the new version; `korn` reminds you.

More: [docs/daemon.md](https://github.com/midnightzkkornz/korn-extension/blob/main/docs/daemon.md)

---

**ภาษาไทย:** sync โน้ต markdown ผ่าน git เบื้องหลัง ติดตั้ง `npm install -g korn-sync` (หรือ pnpm / brew ตามด้านบน) แล้วพิมพ์ `korn setup` จากนั้นพิมพ์ `korn` เพื่อดูสถานะ ถ้าแก้ชนกันจะบอกว่าต้องทำอะไรต่อ · ถอน: `korn uninstall` แล้ว `npm uninstall -g korn-sync`
