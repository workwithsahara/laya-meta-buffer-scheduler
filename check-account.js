const key = process.env.BUFFER_API_KEY;
(async () => {
  const res = await fetch("https://api.buffer.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ query: "query { account { email name } }" }) });
  console.log("RESULT:", JSON.stringify(await res.json()));
})();
