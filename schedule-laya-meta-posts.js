#!/usr/bin/env node
/**
 * LAYA → Buffer (Meta account) daily queue top-up
 * -----------------------------------------------------------------------
 * Standalone twin of the original LAYA Buffer automation, pointed at a
 * SEPARATE Buffer account/login used only for Facebook + Instagram +
 * Threads (Buffer's free plan caps at 3 channels per account, so LAYA
 * uses two separate Buffer logins: one for LinkedIn+TikTok, one for these
 * three). Both scripts read from the same Google Drive content library —
 * this repo is independent of the other one on purpose, so nothing here
 * can accidentally affect the LinkedIn/TikTok automation or vice versa.
 *
 * Runs unattended (e.g. via GitHub Actions cron, or any daily cron job).
 * Each run:
 *   1. Discovers year folders under LAYA_ROOT_FOLDER_ID (e.g. "2026", "2027"),
 *      then month folders under each year (e.g. "august"), then PNGs in each
 *      month folder. No folder IDs are hardcoded — add a new year or month
 *      folder in Drive and it's picked up automatically on the next run.
 *   2. Figures out which (channel, date) pairs are still missing from Buffer.
 *   3. Schedules as many as the account's plan limit allows, earliest date
 *      first, skipping any date before BUFFER_MIN_DATE (useful since Aug
 *      1–12 were already scheduled manually before this automation existed).
 *   4. Posts at POST_TIME_LOCAL in POST_UTC_OFFSET, one per day, per channel.
 *
 * Because Buffer plans cap total *scheduled* (not yet sent) posts, this
 * script is safe to run every day forever — as old posts publish, slots
 * free up and the next unscheduled day gets queued automatically.
 *
 * Required environment variables (set as repo/CI secrets):
 *   BUFFER_API_KEY        Personal API key from this Buffer account's Settings > API
 *   BUFFER_ORG_ID         This Buffer account's organization ID
 *   BUFFER_CHANNEL_IDS    Comma-separated channel IDs (Facebook, Instagram, Threads)
 *   GOOGLE_DRIVE_API_KEY  API key with Drive API enabled (read-only is fine)
 *   LAYA_ROOT_FOLDER_ID   Drive folder ID of the top-level "LAYA" folder
 *                         (the one containing year folders like "2026")
 * Optional:
 *   BUFFER_MIN_DATE       Skip scheduling any date before this (YYYY-MM-DD).
 *                         Set to the day after whatever you already filled
 *                         in manually, to avoid duplicates.
 *   POST_TIME_LOCAL       Default "19:00:00" (7 PM)
 *   POST_UTC_OFFSET       Default "+08:00" (Asia/Manila)
 *   DRY_RUN                "true" to log without creating posts
 *
 * Requires Node.js 18+ (uses global fetch).
 */

const BUFFER_API_KEY = requireEnv("BUFFER_API_KEY");
const ORG_ID = requireEnv("BUFFER_ORG_ID");
const CHANNEL_IDS = requireEnv("BUFFER_CHANNEL_IDS").split(",").map((s) => s.trim());
const DRIVE_API_KEY = requireEnv("GOOGLE_DRIVE_API_KEY");
const ROOT_FOLDER_ID = requireEnv("LAYA_ROOT_FOLDER_ID");

const MIN_DATE = process.env.BUFFER_MIN_DATE || null;
const POST_TIME_LOCAL = process.env.POST_TIME_LOCAL || "19:00:00"; // 7 PM
const POST_UTC_OFFSET = process.env.POST_UTC_OFFSET || "+08:00"; // Asia/Manila
const DRY_RUN = process.env.DRY_RUN === "true";

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

// Lists subfolders of a given folder.
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

// Lists PNGs directly inside a folder.
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

// Discovers LAYA_ROOT_FOLDER_ID/<year>/<month>/*.png and builds a full
// content calendar: { "2026-08-03": { fileId, title }, "2027-01-01": {...}, ... }
async function buildCalendar() {
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

// Returns array of ISO date strings (YYYY-MM-DD, in UTC) that already have
// a scheduled post on this channel.
async function getScheduledDates(channelId) {
  const query = `
    query Posts($organizationId: OrganizationId!, $channelIds: [ChannelId!]) {
      posts(input: { organizationId: $organizationId, filter: { channelIds: $channelIds, status: [scheduled] } }, first: 100) {
        edges { node { dueAt } }
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID, channelIds: [channelId] });
  return new Set(data.posts.edges.map((e) => e.node.dueAt.slice(0, 10)));
}

async function createPost({ channelId, fileId, title, dueAtIso }) {
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
    assets: [
      {
        image: {
          url: `https://lh3.googleusercontent.com/d/${fileId}`,
          metadata: { altText: title },
        },
      },
    ],
  };
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create post: channel=${channelId} dueAt=${dueAtIso} title="${title}"`);
    return;
  }
  const data = await bufferRequest(mutation, { input });
  const payload = data.createPost;
  if (payload.message) {
    throw new Error(`createPost failed: ${payload.message}`);
  }
  console.log(`Scheduled: channel=${channelId} dueAt=${dueAtIso} title="${title}" -> post ${payload.post.id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Run started ${new Date().toISOString()}${DRY_RUN ? " [DRY RUN]" : ""}`);

  const calendar = await buildCalendar();
  const sortedDates = Object.keys(calendar).sort(); // YYYY-MM-DD ascending
  console.log(`Loaded ${sortedDates.length} days of content from Drive.`);

  const limit = await getOrgScheduledPostLimit();
  console.log(`Buffer scheduled-post limit per channel: ${limit}`);
  if (MIN_DATE) {
    console.log(`Minimum date: ${MIN_DATE} (earlier dates skipped, already scheduled manually)`);
  }

  const today = new Date().toISOString().slice(0, 10);

  for (const channelId of CHANNEL_IDS) {
    const scheduledDates = await getScheduledDates(channelId);
    let scheduledCount = scheduledDates.size;
    console.log(`Channel ${channelId}: ${scheduledCount}/${limit} slots currently used.`);

    for (const dateKey of sortedDates) {
      if (scheduledCount >= limit) break;
      if (dateKey < today) continue; // don't schedule into the past
      if (MIN_DATE && dateKey < MIN_DATE) continue; // respect manual pre-fill
      if (scheduledDates.has(dateKey)) continue; // already scheduled

      const { fileId, title } = calendar[dateKey];
      const dueAtIso = `${dateKey}T${POST_TIME_LOCAL}${POST_UTC_OFFSET}`;

      try {
        await createPost({ channelId, fileId, title, dueAtIso });
        scheduledCount++;
      } catch (err) {
        console.error(`Failed to schedule ${dateKey} on ${channelId}: ${err.message}`);
        if (/limit/i.test(err.message)) break;
      }
    }
  }

  console.log("Run complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
