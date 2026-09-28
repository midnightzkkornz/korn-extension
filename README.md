# Korn Markdown Sync

Markdown notes that sync themselves through Git. Open a `.r.md` file and you get a toolbar with 4 view modes and a **Sync** button that commits that one file and pushes it. A side panel shows every note and whether it is up to date, and auto-sync can keep everything in step with your team in the background.

> ภาษาไทยอยู่ด้านล่าง ↓

## Features

- **`.r.md` editor with an always-visible toolbar.** 4 modes in one tab:
  - **View**: rendered markdown, styled like VS Code's own Markdown Preview
  - **Text**: the markdown source with syntax colors
  - **Preview**: source and live preview side by side
  - **Editor**: WYSIWYG editing that only changes the lines you edit (the rest of the file keeps its exact formatting)

  Images with relative paths (`![](img.png)`) show in every mode.
- **One-click Sync.** Commits only the file you're syncing (with the message `update <file> - YYYY-MM-DD HH:mm`), brings in what others pushed, then pushes. Other files you changed or staged are left alone.
- **Conflicts handled for you.** Changes to different lines are merged automatically. When the same lines changed on both sides you choose:
  1. **Replace with my version**
  2. **Save my work as a copy** (the file takes the remote version, yours goes to a new file)
  3. **Resolve in Korn**: pick mine / theirs / both / edit for each conflict, with a result preview, then **Finish & Sync**. Colors show real conflicts (orange) apart from one-sided changes (green / blue).

  You can change your mind at any point, and your other uncommitted work is never lost.
- **Korn Sync side panel** (Activity Bar): every `.r.md` with its state: changed, waiting to push, newer version on the remote, conflict, or last sync time. **Sync all** handles them in one go.
- **Auto-sync** (off by default): sync a few seconds after you save, and/or every N minutes. It also pulls what others pushed, but never while you have unsaved edits in that file.
- **Branch aware**: syncs the branch you have checked out to its upstream, shows it in the panel (`⎇ main → origin/main`), and creates the remote branch on first sync.

## Requirements

- **Git** installed and on your `PATH`
- The notes folder is a Git repository with a remote (for example on GitHub). Push and fetch use VS Code's own Git login.

## Getting started

1. Open a folder that is a Git repository.
2. Click the **Korn Sync** icon in the Activity Bar, then the 📄 button to create `notes.r.md` (or open any `*.r.md` file).
3. Write, then press **⟳ Sync**.

## Settings

| Setting | Default | Description |
|---|---|---|
| `korn.autoSync.onSave` | `false` | Sync a `.r.md` file about 2 seconds after it is saved |
| `korn.autoSync.intervalMinutes` | `0` | Every N minutes: send your changes and get what others pushed (`0` = off) |

## Commands

| Command | Description |
|---|---|
| `Korn: Sync` | Sync the open `.r.md` |
| `Korn: New .r.md File` | Create a note in the workspace |
| `Korn: Korn View` | Reopen the file in the Korn editor |

What auto-sync did and why it skipped something is in **Output → Korn** (the **log** link in the panel).

## Known limitations

- Sync works on the branch that is checked out; changes on other branches are not shown.
- Images must be inside the workspace (relative paths like `![](img.png)` work; absolute paths elsewhere on disk don't).

## License

[MIT](LICENSE)

---

## ภาษาไทย

โน้ต markdown ที่ sync ผ่าน Git ได้ในคลิกเดียว เปิดไฟล์ `.r.md` แล้วจะเจอแถบเครื่องมือที่มี 4 โหมด และปุ่ม **Sync** ที่ commit เฉพาะไฟล์นั้นแล้ว push ให้ แผงด้านซ้ายบอกสถานะของโน้ตทุกไฟล์ และเปิด auto-sync ให้ทำงานเบื้องหลังได้

### ความสามารถ

- **หน้า `.r.md` ที่มีแถบเครื่องมือตลอด** มี 4 โหมดในแท็บเดียว:
  - **View**: แสดงผล markdown แบบเดียวกับ Markdown Preview ของ VS Code
  - **Text**: แก้ markdown ดิบ มีสี syntax
  - **Preview**: ข้อความกับ preview คู่กัน
  - **Editor**: แก้ในหน้าที่แสดงผลแล้ว (WYSIWYG) เปลี่ยนเฉพาะบรรทัดที่แก้ ส่วนอื่นของไฟล์คงรูปแบบเดิมทุกตัวอักษร

  รูปที่ใช้ path แบบ relative (`![](img.png)`) แสดงได้ทุกโหมด
- **Sync คลิกเดียว**: commit เฉพาะไฟล์ที่กด (`update <ไฟล์> - YYYY-MM-DD HH:mm`) ดึงของที่คนอื่น push มารวม แล้ว push ไฟล์อื่นที่แก้ค้างหรือ stage ไว้ไม่ติดไปด้วย
- **จัดการ conflict**: แก้คนละบรรทัด git รวมให้เอง ถ้าแก้บรรทัดเดียวกันจะให้เลือก:
  1. **Replace with my version** ใช้ของเรา
  2. **Save my work as copy** ไฟล์เดิมใช้ของบน remote ส่วนของเราเก็บเป็นไฟล์ใหม่
  3. **Resolve in Korn** เลือกทีละจุด (ของเรา / ของอีกคน / ทั้งคู่ / แก้เอง) มี preview ผลลัพธ์ แล้วกด **Finish & Sync** สีส้มคือจุดที่ชนกันจริง ส่วนสีเขียวและฟ้าคือแก้ฝั่งเดียว

  เปลี่ยนใจกลางทางได้ และงานอื่นที่ยังไม่ได้ commit ไม่หาย
- **แผง Korn Sync** (บน Activity Bar) แสดงโน้ตทุกไฟล์พร้อมสถานะ: แก้แล้วยังไม่ sync, รอ push, มีเวอร์ชันใหม่บน remote, conflict หรือเวลาที่ sync ล่าสุด และมีปุ่ม **Sync all**
- **Auto-sync** (ปิดไว้เป็นค่าเริ่มต้น): sync หลังเซฟ และ/หรือทุก N นาที ดึงของที่คนอื่น push มาให้ด้วย แต่จะไม่ดึงทับไฟล์ที่กำลังพิมพ์ค้างอยู่
- **รองรับหลาย branch**: sync branch ที่ checkout อยู่ไปที่ upstream ของมัน แผงแสดง `⎇ main → origin/main` และ Sync ครั้งแรกจะสร้าง branch บน remote ให้

### สิ่งที่ต้องมี

- ติดตั้ง **Git** ในเครื่อง
- โฟลเดอร์โน้ตเป็น Git repository ที่มี remote (เช่น GitHub) การ push และ fetch ใช้ login เดียวกับ Git ใน VS Code

### เริ่มใช้งาน

1. เปิดโฟลเดอร์ที่เป็น Git repository
2. กดไอคอน **Korn Sync** บน Activity Bar แล้วกดปุ่ม 📄 เพื่อสร้าง `notes.r.md` (หรือเปิดไฟล์ `*.r.md` ที่มีอยู่)
3. เขียนเสร็จแล้วกด **⟳ Sync**

### ตั้งค่า

- `korn.autoSync.onSave`: sync หลังเซฟประมาณ 2 วินาที (ค่าเริ่มต้น: ปิด)
- `korn.autoSync.intervalMinutes`: ทุก N นาทีส่งของเราและดึงของคนอื่น (`0` = ปิด)

ดูว่า auto-sync ทำอะไรไปบ้าง และทำไมถึงข้าม ได้ที่ **Output → Korn** (ลิงก์ **log** ในแผง)

### ข้อจำกัดตอนนี้

- Sync ทำงานกับ branch ที่ checkout อยู่เท่านั้น ไม่แสดงการแก้ใน branch อื่น
- รูปต้องอยู่ใน workspace (path แบบ relative เช่น `![](img.png)` ใช้ได้ แต่ path เต็มไปที่อื่นในเครื่องใช้ไม่ได้)
