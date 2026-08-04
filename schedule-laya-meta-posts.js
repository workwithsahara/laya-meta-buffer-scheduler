#!/usr/bin/env node
/**
 * LAYA → Buffer (Meta account) daily queue top-up (TWO TRACKS, PER CHANNEL)
 * -----------------------------------------------------------------------
 * Standalone twin of the LinkedIn+TikTok LAYA automation, pointed at a
 * SEPARATE Buffer account/login used only for Facebook + Instagram +
 * Threads (Buffer's free plan caps at 3 channels per account, so LAYA
 * uses two separate Buffer logins). Independent repo on purpose — nothing
 * here can affect the other LAYA automation or vice versa.
 *
 * Manages TWO independent content tracks on EACH channel, sharing each
 * channel's ONE Buffer queue:
 *
 *   MAIN track:  the original dated LAYA content — one post per real
 *                calendar day, at POST_TIME_LOCAL, sourced from
 *                LAYA_ROOT_FOLDER_ID/<year>/<month>/DD_<mon><DD>_<slug>.png.
 *                Per-channel BUFFER_MIN_DATE / BUFFER_CHANNEL_MIN_DATES
 *                behavior is UNCHANGED from before.
 *   PROMO track: the "365 LAYA System" promotional series — a flat,
 *                sequentially-numbered library (Day001.png .. Day365.png)
 *                under PROMO_ROOT_FOLDER_ID, posted every
 *                PROMO_INTERVAL_HOURS (default 4h) with a single fixed
 *                caption (PROMO_CAPTION) on every post.
 *
 * Buffer caps the TOTAL number of scheduled (not-yet-sent) posts per
 * CHANNEL — it doesn't know about "tracks". This script manages both
 * together per channel: reads the current queue ONCE, classifies each
 * existing post into MAIN or PROMO by comparing its caption text against
 * PROMO_CAPTION, then interleaves new posts from both tracks in true
 * chronological order until that channel's share of the limit is reached.
 *
 * MAIN candidates come from walking the real calendar-date content
 * library in order (skipping any candidate whose actual due time has
 * already passed — this also fixes a subtle timezone edge case: MAIN
 * posts at 7 PM *Manila* time, but "today" was originally computed in
 * UTC, so a date could look valid by date-string comparison near
 * midnight UTC even though its real Manila due time had already passed).
 * PROMO candidates come from a fixed EPOCH_START + interval grid
 * (deterministic/stateless, same approach as the Loka pipeline).
 *
 * Required environment variables (set as repo/CI secrets):
 *   BUFFER_API_KEY         Personal API key from this Buffer account's Settings > API
 *   BUFFER_ORG_ID          This Buffer account's organization ID
 *   BUFFER_CHANNEL_IDS     Comma-separated channel IDs (Facebook, Instagram, Threads)
 *   GOOGLE_DRIVE_API_KEY   API key with Drive API enabled (read-only is fine)
 *   LAYA_ROOT_FOLDER_ID    Drive folder ID of the MAIN "LAYA" content root
 *   PROMO_ROOT_FOLDER_ID   Drive folder ID of the PROMO content root
 *                          (containing Day001.png .. Day365.png)
 *   PROMO_CAPTION          Fixed caption text used on every PROMO post
 * Optional:
 *   BUFFER_MIN_DATE            Default skip-before date (YYYY-MM-DD) for MAIN,
 *                               applied to any channel without its own override.
 *   BUFFER_CHANNEL_MIN_DATES   Per-channel MAIN overrides, comma-separated
 *                               "channelId=YYYY-MM-DD" pairs (empty date =
 *                               no minimum for that channel).
 *   POST_TIME_LOCAL        Default "19:00:00" (7 PM) — MAIN track only
 *   POST_UTC_OFFSET        Default "+08:00" (Asia/Manila)
 *   PROMO_INTERVAL_HOURS   Default 4
 *   DRY_RUN                 "true" to log without creating posts
 *
 * Requires Node.js 18+ (uses global fetch).
 */

const BUFFER_API_KEY = requireEnv("BUFFER_API_KEY");
const ORG_ID = requireEnv("BUFFER_ORG_ID");
const CHANNEL_IDS = requireEnv("BUFFER_CHANNEL_IDS").split(",").map((s) => s.trim());
const DRIVE_API_KEY = requireEnv("GOOGLE_DRIVE_API_KEY");
const ROOT_FOLDER_ID = requireEnv("LAYA_ROOT_FOLDER_ID");
const PROMO_ROOT_FOLDER_ID = requireEnv("PROMO_ROOT_FOLDER_ID");
const PROMO_CAPTION = requireEnv("PROMO_CAPTION");

const DEFAULT_MIN_DATE = process.env.BUFFER_MIN_DATE || null;

function parseChannelMinDates(raw) {
  const map = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const [channelId, date] = pair.split("=").map((s) => (s || "").trim());
    if (!channelId) continue;
    map[channelId] = date || null;
  }
  return map;
}
const CHANNEL_MIN_DATES = parseChannelMinDates(process.env.BUFFER_CHANNEL_MIN_DATES);
function minDateFor(channelId) {
  return channelId in CHANNEL_MIN_DATES ? CHANNEL_MIN_DATES[channelId] : DEFAULT_MIN_DATE;
}

const POST_TIME_LOCAL = process.env.POST_TIME_LOCAL || "19:00:00"; // 7 PM
const POST_UTC_OFFSET = process.env.POST_UTC_OFFSET || "+08:00"; // Asia/Manila
const PROMO_INTERVAL_HOURS = parseInt(process.env.PROMO_INTERVAL_HOURS || "4", 10);
const DRY_RUN = process.env.DRY_RUN === "true";

// Fixed anchor so PROMO image selection is stateless and deterministic
// across runs. Must match the same anchor used on the other LAYA repo if
// you want both accounts' PROMO cycles to stay in sync (not required for
// correctness, just tidy). Never change this once PROMO posts are live.
const PROMO_EPOCH_START = new Date("2026-08-05T00:00:00Z");
const LEAD_BUFFER_MS = 5 * 60 * 1000; // 5-minute lead so dueAt is always in the future

const MONTH_NUMBERS = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------
async function listSubfolders(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive folder list failed for ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.files || [];
}

async function listDriveFolderFiles(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `'${folderId}' in parents and mimeType = 'image/png' and trashed = false`);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive file list failed for folder ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.files || [];
}

// Lists ALL images (any type) directly under a folder, sorted naturally.
// Used for the flat PROMO library (Day001.png .. Day365.png).
async function listDriveImagesFlat(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive file list failed for ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const files = data.files || [];
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Parses "03_aug03_american-family-day.png" -> { day: 3, slug: "american-family-day" }
function parseFilename(name) {
  const m = name.match(/^(\d{1,2})_[a-z]+\d{1,2}_(.+)\.png$/i);
  if (!m) return null;
  return { day: parseInt(m[1], 10), slug: m[2] };
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Discovers LAYA_ROOT_FOLDER_ID/<year>/<month>/*.png and builds the MAIN
// content calendar: { "2026-08-03": { fileId, title }, ... }
async function buildMainCalendar() {
  const calendar = {};
  const yearFolders = await listSubfolders(ROOT_FOLDER_ID);

  for (const yearFolder of yearFolders) {
    if (!/^\d{4}$/.test(yearFolder.name)) {
      console.warn(`Skipping non-year folder under LAYA root: ${yearFolder.name}`);
      continue;
    }
    const year = yearFolder.name;
    const monthFolders = await listSubfolders(yearFolder.id);

    for (const monthFolder of monthFolders) {
      const monthKey = monthFolder.name.toLowerCase();
      const monthNum = MONTH_NUMBERS[monthKey];
      if (!monthNum) {
        console.warn(`Skipping unrecognized month folder: ${year}/${monthFolder.name}`);
        continue;
      }

      const files = await listDriveFolderFiles(monthFolder.id);
      for (const f of files) {
        const parsed = parseFilename(f.name);
        if (!parsed) {
          console.warn(`Skipping file with unexpected name: ${year}/${monthFolder.name}/${f.name}`);
          continue;
        }
        const dateKey = `${year}-${monthNum}-${String(parsed.day).padStart(2, "0")}`;
        calendar[dateKey] = { fileId: f.id, title: titleFromSlug(parsed.slug) };
      }
    }
  }

  return calendar;
}

// ---------------------------------------------------------------------------
// PROMO track helpers (fixed epoch grid, same technique as Loka)
// ---------------------------------------------------------------------------
const PROMO_INTERVAL_MS = PROMO_INTERVAL_HOURS * 3600000;

function promoSlotIndexForTime(date) {
  return Math.floor((date.getTime() - PROMO_EPOCH_START.getTime()) / PROMO_INTERVAL_MS);
}

function promoTimeForSlotIndex(slotIndex) {
  return new Date(PROMO_EPOCH_START.getTime() + slotIndex * PROMO_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Buffer GraphQL helpers
// ---------------------------------------------------------------------------
async function bufferRequest(query, variables) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(`Buffer API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

async function getChannelServices(channelIds) {
  const query = `
    query Channels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId }) {
        id
        service
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID });
  const map = {};
  for (const ch of data.channels) {
    if (channelIds.includes(ch.id)) map[ch.id] = ch.service;
  }
  return map;
}

async function getOrgScheduledPostLimit() {
  const query = `
    query Account {
      account {
        organizations {
          id
          limits { scheduledPosts }
        }
      }
    }
  `;
  const data = await bufferRequest(query, {});
  const org = data.account.organizations.find((o) => o.id === ORG_ID);
  return org ? org.limits.scheduledPosts : 3;
}

// Returns [{ dueAt: Date, text: string }] for every currently-scheduled
// post on the channel, so we can classify each into MAIN or PROMO.
async function getScheduledPosts(channelId) {
  const query = `
    query Posts($organizationId: OrganizationId!, $channelIds: [ChannelId!]) {
      posts(input: { organizationId: $organizationId, filter: { channelIds: $channelIds, status: [scheduled] } }, first: 100) {
        edges { node { dueAt text } }
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID, channelIds: [channelId] });
  return data.posts.edges.map((e) => ({
    dueAt: new Date(e.node.dueAt),
    text: e.node.text || "",
  }));
}

async function createPost({ channelId, service, fileId, title, dueAtIso }) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
        ... on UnexpectedError { message }
      }
    }
  `;
  const input = {
    channelId,
    mode: "customScheduled",
    schedulingType: "automatic",
    dueAt: dueAtIso,
    text: title || undefined,
    assets: [
      {
        image: {
          url: `https://lh3.googleusercontent.com/d/${fileId}`,
          metadata: { altText: title || "LAYA" },
        },
      },
    ],
  };

  // Facebook and Instagram require an explicit post "type" — applies to
  // BOTH tracks (MAIN and PROMO), since it's a per-network requirement,
  // not a per-content-type one.
  if (service === "facebook") {
    input.metadata = { facebook: { type: "post" } };
  } else if (service === "instagram") {
    input.metadata = { instagram: { type: "post", shouldShareToFeed: true } };
  }
  // Threads doesn't require an explicit type — leave as-is.

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create post: channel=${channelId} (${service}) dueAt=${dueAtIso} title="${title}"`);
    return;
  }
  const data = await bufferRequest(mutation, { input });
  const payload = data.createPost;
  if (payload.message) {
    throw new Error(`createPost failed: ${payload.message}`);
  }
  console.log(`Scheduled: channel=${channelId} (${service}) dueAt=${dueAtIso} title="${title}" -> post ${payload.post.id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Run started ${new Date().toISOString()}${DRY_RUN ? " [DRY RUN]" : ""}`);

  const mainCalendar = await buildMainCalendar();
  const sortedMainDates = Object.keys(mainCalendar).sort();
  console.log(`MAIN: loaded ${sortedMainDates.length} days of dated content from Drive.`);

  const promoImages = await listDriveImagesFlat(PROMO_ROOT_FOLDER_ID);
  console.log(`PROMO: loaded ${promoImages.length} images from Drive.`);

  const limit = await getOrgScheduledPostLimit();
  console.log(`Buffer scheduled-post limit per channel: ${limit}`);

  const services = await getChannelServices(CHANNEL_IDS);

  for (const channelId of CHANNEL_IDS) {
    const service = services[channelId] || "unknown";
    const channelMinDate = minDateFor(channelId);
    console.log(`\nChannel ${channelId} (${service}) — MAIN minimum date: ${channelMinDate || "(none — starts today)"}`);

    let scheduled;
    try {
      scheduled = await getScheduledPosts(channelId);
    } catch (err) {
      console.error(`  Skipping channel: couldn't read current schedule (${err.message})`);
      continue;
    }

    const mainScheduled = scheduled.filter((p) => p.text !== PROMO_CAPTION);
    const promoScheduled = scheduled.filter((p) => p.text === PROMO_CAPTION);
    const scheduledMainDates = new Set(mainScheduled.map((p) => p.dueAt.toISOString().slice(0, 10)));

    console.log(
      `  ${scheduled.length}/${limit} total slots used (MAIN: ${mainScheduled.length}, PROMO: ${promoScheduled.length}).`
    );

    const slotsToFill = limit - scheduled.length;
    if (slotsToFill <= 0) {
      console.log("  Already at limit. Nothing to add this run.");
      continue;
    }

    // MAIN candidates: real calendar dates, respecting this channel's
    // min-date, not already scheduled.
    const mainCandidateDates = sortedMainDates.filter(
      (d) => (!channelMinDate || d >= channelMinDate) && !scheduledMainDates.has(d)
    );
    let mainPointer = 0;

    // PROMO candidates: next empty slot on the fixed grid.
    const nowPromoSlot = Math.ceil(
      (Date.now() + LEAD_BUFFER_MS - PROMO_EPOCH_START.getTime()) / PROMO_INTERVAL_MS
    );
    const latestPromoSlot = promoScheduled.length
      ? Math.max(...promoScheduled.map((p) => promoSlotIndexForTime(p.dueAt)))
      : -1;
    let nextPromoSlot = Math.max(nowPromoSlot, latestPromoSlot + 1);

    let filled = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    while (filled < slotsToFill) {
      // Skip any MAIN candidate whose real due time has already passed —
      // possible near midnight UTC since MAIN posts at 7 PM Manila, not UTC.
      while (
        mainPointer < mainCandidateDates.length &&
        new Date(`${mainCandidateDates[mainPointer]}T${POST_TIME_LOCAL}${POST_UTC_OFFSET}`).getTime() <
          Date.now() + LEAD_BUFFER_MS
      ) {
        console.log(`  Skipping stale MAIN date ${mainCandidateDates[mainPointer]} (due time already passed).`);
        mainPointer++;
      }

      const mainAvailable = mainPointer < mainCandidateDates.length;
      const mainDateKey = mainAvailable ? mainCandidateDates[mainPointer] : null;
      const mainTime = mainAvailable
        ? new Date(`${mainDateKey}T${POST_TIME_LOCAL}${POST_UTC_OFFSET}`)
        : null;
      const promoTime = promoTimeForSlotIndex(nextPromoSlot);

      const useMain = mainAvailable && mainTime.getTime() <= promoTime.getTime();

      let fileId, title, dueAt, trackLabel;
      if (useMain) {
        const entry = mainCalendar[mainDateKey];
        fileId = entry.fileId;
        title = entry.title;
        dueAt = mainTime;
        trackLabel = "MAIN";
      } else {
        const imageIndex = ((nextPromoSlot % promoImages.length) + promoImages.length) % promoImages.length;
        fileId = promoImages[imageIndex].id;
        title = PROMO_CAPTION;
        dueAt = promoTime;
        trackLabel = "PROMO";
      }

      const dueAtIso = dueAt.toISOString();

      try {
        await createPost({ channelId, service, fileId, title, dueAtIso });
        console.log(`  (${trackLabel})`);
        filled++;
        consecutiveFailures = 0;
      } catch (err) {
        console.error(`  Failed to schedule ${trackLabel} slot (${dueAtIso}): ${err.message}`);
        consecutiveFailures++;
        if (/limit/i.test(err.message)) {
          console.log("  Buffer reports the scheduled-post limit is reached. Stopping this channel.");
          break;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`  Stopping this channel after ${consecutiveFailures} consecutive failures.`);
          break;
        }
      }

      if (useMain) {
        mainPointer++;
      } else {
        nextPromoSlot++;
      }
    }

    console.log(`  Filled ${filled} slot(s) this run.`);
  }

  console.log("\nRun complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
