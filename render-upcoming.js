#!/usr/bin/env node
/**
 * Pre-renders the audio videos for the next RENDER_DAYS days of LAYA quote posts,
 * so every pipeline (including the private LAYA TikTok one) finds them ready.
 * Reads the same Drive calendar the scheduler uses. Needs ffmpeg + GITHUB_TOKEN.
 *
 *   RENDER_DAYS   how many upcoming days to render (default 16)
 */
const AV = require("./audio-video");

const KEY = process.env.GOOGLE_DRIVE_API_KEY;
const ROOT = process.env.LAYA_ROOT_FOLDER_ID;
const DAYS = parseInt(process.env.RENDER_DAYS || "16", 10);
const MONTHS = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };

if (!AV.ENABLED) { console.log("AUDIO_VIDEO is off. Nothing to render."); process.exit(0); }
if (!AV.CAN_RENDER) { console.error("This run cannot render (missing GITHUB_TOKEN or MEDIA_REPO mismatch)."); process.exit(1); }
if (!KEY || !ROOT) { console.error("Missing GOOGLE_DRIVE_API_KEY or LAYA_ROOT_FOLDER_ID."); process.exit(1); }

async function drive(q, fields = "files(id,name)") {
  const u = new URL("https://www.googleapis.com/drive/v3/files");
  u.searchParams.set("q", q); u.searchParams.set("fields", fields); u.searchParams.set("pageSize", "200"); u.searchParams.set("key", KEY);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Drive list failed: ${r.status} ${await r.text()}`);
  return (await r.json()).files || [];
}

async function main() {
  const todayManila = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const last = new Date(Date.now() + 8 * 3600 * 1000 + DAYS * 86400000).toISOString().slice(0, 10);
  const calendar = {};
  const years = await drive(`'${ROOT}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  for (const y of years) {
    if (!/^\d{4}$/.test(y.name)) continue;
    if (y.name < todayManila.slice(0, 4) || y.name > last.slice(0, 4)) continue;
    const months = await drive(`'${y.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    for (const m of months) {
      const mn = MONTHS[m.name.toLowerCase()];
      if (!mn) continue;
      if (`${y.name}-${mn}` < todayManila.slice(0, 7) || `${y.name}-${mn}` > last.slice(0, 7)) continue;
      const files = await drive(`'${m.id}' in parents and mimeType = 'image/png' and trashed = false`);
      for (const f of files) {
        const d = f.name.match(/^(\d{1,2})_/);
        if (!d) continue;
        calendar[`${y.name}-${mn}-${String(parseInt(d[1], 10)).padStart(2, "0")}`] = f.id;
      }
    }
  }
  const dates = Object.keys(calendar).filter((d) => d >= todayManila && d <= last).sort();
  console.log(`Rendering ${dates.length} upcoming day(s): ${dates[0] || "-"} to ${dates[dates.length - 1] || "-"}`);
  let ok = 0, fail = 0;
  for (const d of dates) {
    try {
      const url = await AV.getAudioVideoUrl(calendar[d]);
      console.log(`${d}: ${url}`);
      ok++;
    } catch (e) {
      console.error(`${d}: FAILED ${e.message}`);
      fail++;
    }
  }
  console.log(`Done. ${ok} ready, ${fail} failed.`);
  if (fail > 0 && ok === 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
