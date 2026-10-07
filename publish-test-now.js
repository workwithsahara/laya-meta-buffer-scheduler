// One-off: publish ONE kindness post right now to Facebook and Threads (test).
const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";
const BUFFER_API_KEY = process.env.BUFFER_API_KEY;
const ORG_ID = process.env.BUFFER_ORG_ID;
const CHANNEL_IDS = (process.env.BUFFER_CHANNEL_IDS || "").split(",").map((s) => s.trim());
const TEXT = `Affection between people can be as natural as a mother's love.

"Love one another as the cow loves her newborn calf."

Atharva Veda 3.30.1, Hinduism

Who in your life deserves a more natural, open kind of love?`;

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

(async () => {
  const chq = `query Channels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id service } }`;
  const chData = await bufferRequest(chq, { organizationId: ORG_ID });
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
        ... on UnexpectedError { message }
      }
    }`;
  for (const ch of chData.channels) {
    if (!CHANNEL_IDS.includes(ch.id)) continue;
    if (ch.service !== "facebook" && ch.service !== "threads") { console.log(`Skipping ${ch.service} (needs an image).`); continue; }
    const input = { channelId: ch.id, mode: "shareNow", schedulingType: "automatic", text: TEXT };
    if (ch.service === "facebook") input.metadata = { facebook: { type: "post" } };
    try {
      const data = await bufferRequest(mutation, { input });
      const p = data.createPost;
      if (p.message) console.log(`FAILED ${ch.service}: ${p.message}`);
      else console.log(`POSTED ${ch.service}: id=${p.post.id} status=${p.post.status}`);
    } catch (err) {
      console.log(`FAILED ${ch.service}: ${err.message}`);
    }
  }
})();
