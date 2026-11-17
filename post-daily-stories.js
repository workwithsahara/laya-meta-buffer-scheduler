/**
 * LAYA daily stories
 *
 * Posts the story set that lives in the Google Drive folder "LAYA Daily Stories"
 * (story-1-video.mp4, story-2-image.jpg, story-3-video.mp4, story-4-image.jpg),
 * in file-name order, once a day: video, image, video, image.
 *
 *   - Facebook / Instagram channels  -> posted as Stories (type "story")
 *   - TikTok channels                -> posted as normal TikTok video / photo posts
 *     (Buffer has no TikTok "story" type). Videos are labelled AI-generated.
 *
 * Posts go out immediately ("shareNow"), one after another with a short gap so
 * the order is kept, so they do not use any of the scheduled-post slots.
 *
 * To change the stories: replace / add / rename files in the Drive folder.
 * Files are posted in natural file-name order. No code change needed.
 *
 * Env:
 *   BUFFER_API_KEY, BUFFER_ORG_ID           required
 *   BUFFER_CHANNEL_IDS or BUFFER_CHANNEL_ID  comma separated channel ids of this Buffer account
 *   GOOGLE_DRIVE_API_KEY                     required
 *   STORY_SERVICES        which services to post to, e.g. "facebook,instagram" or "tiktok"
 *   STORIES_FOLDER_ID     optional, defaults to the LAYA Daily Stories folder
 *   STORY_GAP_SECONDS     optional, pause between stories on one channel (default 60)
 *   STORY_AI_LABEL        optional, "false" turns off the AI-generated label on TikTok videos
 *   DRY_RUN               "true" = log only, post nothing
 */
"use strict";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

const BUFFER_API_KEY = need("BUFFER_API_KEY");
const ORG_ID = need("BUFFER_ORG_ID");
const DRIVE_API_KEY = need("GOOGLE_DRIVE_API_KEY");
const CHANNEL_IDS = (process.env.BUFFER_CHANNEL_IDS || process.env.BUFFER_CHANNEL_ID || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const SERVICES = (process.env.STORY_SERVICES || "facebook,instagram,tiktok")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const FOLDER_ID = process.env.STORIES_FOLDER_ID || "1BmEB05eEDQnBIF3iGf34lH3sN7sZ_bqJ";
const GAP_MS = Math.max(0, parseInt(process.env.STORY_GAP_SECONDS || "60", 10)) * 1000;
const AI_LABEL = process.env.STORY_AI_LABEL !== "false";
const DRY_RUN = process.env.DRY_RUN === "true";
const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

if (!CHANNEL_IDS.length) {
  console.error("Missing BUFFER_CHANNEL_IDS (or BUFFER_CHANNEL_ID).");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bufferRequest(query, variables) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BUFFER_API_KEY}` },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Buffer API error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

async function listStoryFiles() {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `'${FOLDER_ID}' in parents and (mimeType contains 'image/' or mimeType contains 'video/') and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name,mimeType)");
  url.searchParams.set("pageSize", "50");
  url.searchParams.set("key", DRIVE_API_KEY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Drive list failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.files || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function mediaUrl(file) {
  return file.mimeType.startsWith("video/")
    ? `https://drive.google.com/uc?export=download&id=${file.id}`
    : `https://lh3.googleusercontent.com/d/${file.id}`;
}

async function getChannels() {
  const query = `
    query Channels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId }) { id service name }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID });
  return data.channels.filter((c) => CHANNEL_IDS.includes(c.id) && SERVICES.includes(c.service));
}

async function postStory(channel, file) {
  const isVideo = file.mimeType.startsWith("video/");
  const input = {
    channelId: channel.id,
    mode: "shareNow",
    schedulingType: "automatic",
    assets: [
      isVideo
        ? { video: { url: mediaUrl(file) } }
        : { image: { url: mediaUrl(file), metadata: { altText: "LAYA 365" } } },
    ],
  };
  if (channel.service === "facebook") {
    input.metadata = { facebook: { type: "story" } };
  } else if (channel.service === "instagram") {
    input.metadata = { instagram: { type: "story", shouldShareToFeed: false } };
  } else if (channel.service === "tiktok" && isVideo && AI_LABEL) {
    input.metadata = { tiktok: { isAiGenerated: true } };
  }

  const label = `${channel.service}/${channel.name} <- ${file.name}`;
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would post now: ${label} (${isVideo ? "video" : "image"}) ${JSON.stringify(input.metadata || {})}`);
    return;
  }
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status } }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
        ... on UnexpectedError { message }
      }
    }
  `;
  const data = await bufferRequest(mutation, { input });
  const payload = data.createPost;
  if (payload.message) throw new Error(`createPost failed: ${payload.message}`);
  console.log(`Posted: ${label} -> post ${payload.post.id} (${payload.post.status})`);
}

async function runChannel(channel, files) {
  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      await postStory(channel, files[i]);
    } catch (err) {
      failed++;
      console.error(`FAILED: ${channel.service}/${channel.name} <- ${files[i].name}: ${err.message}`);
    }
    if (i < files.length - 1 && !DRY_RUN) await sleep(GAP_MS);
  }
  return failed;
}

(async () => {
  console.log(`LAYA daily stories. Services: ${SERVICES.join(", ")}. Dry run: ${DRY_RUN}.`);
  const files = await listStoryFiles();
  if (files.length === 0) {
    console.error("No story files found in the Drive folder. Nothing to post.");
    process.exit(1);
  }
  console.log(`Story order: ${files.map((f) => f.name).join(" -> ")}`);
  const channels = await getChannels();
  if (channels.length === 0) {
    console.error(`No matching channels (services: ${SERVICES.join(", ")}) among the configured channel ids.`);
    process.exit(1);
  }
  console.log(`Channels: ${channels.map((c) => `${c.service}/${c.name}`).join(", ")}`);
  const results = await Promise.all(channels.map((c) => runChannel(c, files)));
  const failed = results.reduce((a, b) => a + b, 0);
  if (failed > 0) {
    console.error(`${failed} story post(s) failed.`);
    process.exit(1);
  }
  console.log("Done.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
