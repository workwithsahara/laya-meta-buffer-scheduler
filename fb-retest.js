const key = process.env.BUFFER_API_KEY;
const ORG = process.env.BUFFER_ORG_ID;
const IDS = (process.env.BUFFER_CHANNEL_IDS || "").split(",").map((s) => s.trim());
const OLD_ERROR_POST = "6ac5f7f6203d24e39e133a97";
const TEXT = `Affection between people can be as natural as a mother's love.

"Love one another as the cow loves her newborn calf."

Atharva Veda 3.30.1, Hinduism

Who in your life deserves a more natural, open kind of love?`;
async function q(query, variables) {
  const res = await fetch("https://api.buffer.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ query, variables }) });
  return res.json();
}
(async () => {
  const ch = await q(`query C($o: OrganizationId!) { channels(input: { organizationId: $o }) { id service name isDisconnected isLocked } }`, { o: ORG });
  const chans = (ch.data && ch.data.channels) || [];
  for (const c of chans) if (IDS.includes(c.id)) console.log(`RESULT: channel ${c.service} "${c.name}" disconnected=${c.isDisconnected} locked=${c.isLocked}`);
  const fb = chans.find((c) => c.service === "facebook" && IDS.includes(c.id));
  if (!fb || fb.isDisconnected) { console.log("RESULT: facebook still disconnected, not posting"); return; }
  const m = `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id status } } ... on LimitReachedError { message } ... on InvalidInputError { message } ... on UnexpectedError { message } } }`;
  const out = await q(m, { input: { channelId: fb.id, mode: "shareNow", schedulingType: "automatic", text: TEXT, metadata: { facebook: { type: "post" } } } });
  const p = out.data && out.data.createPost;
  console.log("RESULT: create ->", JSON.stringify(out).slice(0, 400));
  if (p && p.post) {
    await new Promise((r) => setTimeout(r, 10000));
    const st = await q(`query P($id: PostId!) { post(input: { id: $id }) { id status error { message } } }`, { id: p.post.id });
    console.log("RESULT: status ->", JSON.stringify(st).slice(0, 400));
    if (st.data && st.data.post && st.data.post.status === "sent") {
      const del = await q(`mutation D($id: PostId!) { deletePost(input: { id: $id }) { __typename } }`, { id: OLD_ERROR_POST });
      console.log("RESULT: delete old failed post ->", JSON.stringify(del).slice(0, 300));
    }
  }
})();
