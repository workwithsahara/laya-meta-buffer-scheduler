const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";
const BUFFER_API_KEY = process.env.BUFFER_API_KEY;
async function q(query, variables) {
  const res = await fetch(BUFFER_GRAPHQL_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${BUFFER_API_KEY}` }, body: JSON.stringify({ query, variables }) });
  return res.json();
}
(async () => {
  const tries = [
    `query P($id: PostId!) { post(input: { id: $id }) { id status error { message } } }`,
    `query P($id: PostId!) { post(input: { id: $id }) { id status error } }`,
  ];
  for (const t of tries) {
    const out = await q(t, { id: "6ac5f7f6203d24e39e133a97" });
    console.log("RESULT:", JSON.stringify(out).slice(0, 900));
    if (out.data && out.data.post) break;
  }
})();
