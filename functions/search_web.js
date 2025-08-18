// /functions/search_web.js  (ESM)
// Fetch a web page and find a term; return short context snippets.

export const searchWebTool = {
  type: "function",
  name: "search_web",
  description: "Fetch a web page and find occurrences of a term. Returns short context snippets.",
  parameters: {
    type: "object",
    properties: {
      url:  { type: "string", description: "Full URL to search (https://…)" },
      term: { type: "string", description: "Word or phrase to look for (case-insensitive)" },
      max_snippets: { type: "integer", minimum: 1, maximum: 10, default: 5 }
    },
    required: ["url", "term"]
  }
};

export async function search_web({ url, term, max_snippets = 5 }) {
  if (!url || !term) throw new Error("Missing url or term");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000); // 10s timeout

  const resp = await fetch(url, {
    headers: {
      "User-Agent": "SmartFlows-CallAgent/1.0",
      "Accept": "text/html,*/*"
    },
    redirect: "follow",
    signal: controller.signal
  }).catch(err => {
    throw new Error(`Fetch failed: ${err.message}`);
  });
  clearTimeout(timer);

  if (!resp || !resp.ok) {
    throw new Error(`HTTP ${resp?.status ?? "?"} fetching ${url}`);
  }

  const html = await resp.text();

  // Strip scripts/styles/tags, collapse whitespace
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const hay = text.toLowerCase();
  const needle = String(term).toLowerCase();

  const MAX = Math.max(1, Math.min(10, Number(max_snippets)));
  const snippets = [];
  let i = 0;

  while (snippets.length < MAX) {
    i = hay.indexOf(needle, i);
    if (i === -1) break;
    const start = Math.max(0, i - 80);
    const end   = Math.min(text.length, i + needle.length + 80);
    snippets.push(text.slice(start, end));
    i += needle.length;
  }

  return {
    url,
    term,
    hits: snippets.length,
    snippets
  };
}
