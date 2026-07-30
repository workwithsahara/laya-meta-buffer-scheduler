# LAYA → Buffer (Meta account) daily queue top-up

This is a **standalone twin** of the original LAYA Buffer automation
(`laya-buffer-scheduler`), pointed at a **second, separate Buffer
account/login** used only for **Facebook, Instagram, and Threads**.

Why a second repo instead of one script doing both: Buffer's free plan caps
out at 3 connected channels per account. LAYA already used all 3 slots on
the first Buffer account for LinkedIn + TikTok (+ one more), so a second
Buffer login was created for these three Meta-adjacent channels. Keeping
this in its own repo means the two automations are fully independent —
nothing here can ever break or interfere with the LinkedIn/TikTok one, and
vice versa.

**Both repos read from the same Google Drive content library**
(`LAYA/<year>/<month>/...`) — no duplicate content to maintain.

## What it does

Same behavior as the original: every day, checks how many posts are
currently scheduled per channel on this Buffer account, and if there's
room under the plan's limit, queues the next unscheduled day's LAYA
graphic at 7:00 PM Manila time. Self-refills forever as older posts
publish and slots reopen — no manual "top up" needed.

## One-time setup

### 1. Get this account's Buffer API key
1. Log into **this second Buffer account** (the one connected to Facebook/
   Instagram/Threads) → **Settings → API**.
2. Create a **personal API key**.
3. Copy it — this is `BUFFER_API_KEY`.

### 2. Reuse the same Google Drive API key
If you already set up `GOOGLE_DRIVE_API_KEY` for the other repo, use the
exact same value here — no need to create a second one. If not: see the
other repo's README for how to generate one via Google Cloud Console.

### 3. Your Buffer org/channel IDs for this account
- `BUFFER_ORG_ID`: `6a6b89d20be6bb6ef0dce5a5`
- `BUFFER_CHANNEL_IDS`: `6a6b8a194b2d03035f6cf7e8,6a6b8bc04b2d03035f6cffca,6a6b8c854b2d03035f6d0308`
  (Facebook "Laya", Instagram "live.by.laya", Threads "live.by.laya")

### 4. Your LAYA root folder ID (same as the other repo)
- `LAYA_ROOT_FOLDER_ID`: `17baWNJiOazZvoPNT--M6w2Sy8XbcU7xi`

Make sure this folder (or everything under it) is shared as **"Anyone with
the link — Viewer"** — the Drive API key can only read publicly-shared
files, not private ones.

### 5. Set the minimum date
Since **Aug 1–12** were already scheduled manually on this account before
this automation existed, set:
- `BUFFER_MIN_DATE`: `2026-08-13`

This tells the script to never touch or duplicate anything before that
date — it'll only ever fill in Aug 13 onward.

### 6. Create the GitHub repo and add secrets
1. Create a **new, separate GitHub repository** — e.g. `laya-meta-buffer-scheduler`.
2. Upload `schedule-laya-meta-posts.js`, `.github/workflows/schedule-laya-meta-posts.yml`,
   and this `README.md` (keep the `.github/workflows/` path intact).
3. Go to **Settings → Secrets and variables → Actions** and add:



### 7. Test it
Go to the **Actions** tab → **Top up LAYA Meta Buffer queue** → **Run
workflow** → check **dry_run** → Run. Check the log output — it should
report the current slot usage per channel and (once slots open up past
Aug 13) log what it would schedule.

Once you're happy, run it once for real (dry_run unchecked) to confirm a
post actually gets created, then leave it — it runs daily on its own via
the cron schedule in the workflow file.

## Notes

- This account's plan limit is read live from Buffer, same as the other
  repo — if you upgrade this Buffer account's plan, the script
  automatically schedules further ahead with no code changes.
- Posts are created with no caption/body text — image only.
- Adding new content years/months works exactly like the other repo: just
  add folders under `LAYA/<year>/<month>/` in Drive, no code changes needed.
