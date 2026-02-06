// index.ts (Deno server setup for Railway)
import puppeteer from "https://deno.land/x/puppeteer@16.2.0/mod.ts"

const port = Number(Deno.env.get("PORT") ?? "8080");

type ReqBody = {
  linkedin_url?: string;
  x_url?: string;
};

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function extractXUsername(xUrl?: string | null): string | null {
  if (!xUrl) return null;
  try {
    const u = new URL(xUrl);
    if (!u.hostname.includes("x.com") && !u.hostname.includes("twitter.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    return parts[0].replace("@", "") || null;
  } catch {
    return null;
  }
}

function extractLinkedInSlug(linkedinUrl?: string | null): string | null {
  if (!linkedinUrl) return null;
  try {
    const u = new URL(linkedinUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    const inIdx = parts.findIndex((p) => p === "in");
    if (inIdx >= 0 && parts[inIdx + 1]) return parts[inIdx + 1];
    return null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}


function extractFirstJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function dedupeByLink(items: any[]) {
  const m = new Map<string, any>();
  for (const it of items) {
    const k = String(it?.link ?? "").trim();
    if (!k) continue;
    if (!m.has(k)) m.set(k, it);
  }
  return Array.from(m.values());
}

/* -------------------------------------------------
  Serper Web Search (replaces Google HTML scraping)
-------------------------------------------------- */
async function executeWebSearch(query: string, num_results: number) {
  const key = Deno.env.get("SERPER_API_KEY");
  if (!key) throw new Error("Missing SERPER_API_KEY");
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      num: Math.min(num_results, 20),
      gl: "uk",
      hl: "en",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Serper error ${res.status}: ${text.slice(0, 400)}`);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Serper returned non-JSON: ${text.slice(0, 200)}`);
  }
  const organic = data.organic ?? [];
  return organic.slice(0, Math.min(num_results, 20)).map((r: any) => ({
    title: r.title ?? null,
    link: r.link ?? null,
    snippet: r.snippet ?? null,
  }));
}

/* -------------------------------------------------
  New Browse Page (fetches full text; for PDFs uses pdf-parse)
-------------------------------------------------- */
async function executeBrowsePage(url: string, instructions: string) {
  const lower = url.toLowerCase();
  // ---------- helpers ----------
  const looksLikePdfByExt = lower.endsWith(".pdf");
  async function isPdfByHead(u: string): Promise<boolean> {
    try {
      const head = await fetchWithTimeout(u, { method: "HEAD" }, 10000);
      const ct = (head.headers.get("content-type") || "").toLowerCase();
      return ct.includes("application/pdf");
    } catch {
      return false; // if HEAD fails, don't hard-fail; we'll treat as HTML unless ext says pdf
    }
  }
  // Detect PDF by extension OR by content-type
  const isPdf = looksLikePdfByExt || await isPdfByHead(url);
  // ---------- PDF path ----------
  if (isPdf) {
    const worker = Deno.env.get("PDF_WORKER_URL");
    if (!worker) throw new Error("Missing PDF_WORKER_URL");
    const endpoint = `${worker.replace(/\/$/, "")}/extract`;
    console.log("[browse_page] PDF detected -> calling pdf-worker", { endpoint, url });
    const resp = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      },
      20000,
    );
    const raw = await resp.text();
    if (!resp.ok) {
      throw new Error(`pdf-worker error ${resp.status}: ${raw.slice(0, 300)}`);
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`pdf-worker returned non-JSON: ${raw.slice(0, 300)}`);
    }
    return data?.text ?? "";
  }

  // ---------- HTML path ----------
 // ---------- HTML path ----------
console.log("[browse_page] HTML fetch", { url });
const isLinkedIn = lower.includes("linkedin.com");
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};
if (isLinkedIn) {
  headers["Referer"] = "https://www.google.com/";
  headers["Connection"] = "keep-alive";
  headers["DNT"] = "1";
}
let raw = '';
let attempts = 0;
const maxRetries = 3;
while (attempts < maxRetries) {
  try {
    if (isLinkedIn) {
      // Use Puppeteer for LinkedIn to render JS
      const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();
      await page.setExtraHTTPHeaders(headers);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      raw = await page.content();
      await browser.close();
    } else {
      // Regular fetch for non-LinkedIn
      const res = await fetchWithTimeout(url, { headers }, 20000);
      raw = await res.text();
    }
    if (raw.length > 0) break; // Success if content fetched
    attempts++;
    console.log(`[browse_page] Retry ${attempts}/${maxRetries}`);
    await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
  } catch (e) {
    attempts++;
    console.error(`[browse_page] Attempt ${attempts} failed: ${e}`);
    if (attempts >= maxRetries) throw new Error(`Browse failed after retries: ${e.message}`);
  }
}
return raw
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 80000);
}


/* -------------------------------------------------
  X API (timeline-first, replies included)
-------------------------------------------------- */
async function xApiFetchJson(url: string, bearer: string) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      "User-Agent": "SocialGravityScraper/1.0",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X API error ${res.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`X API returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function resolveXUserByUsername(username: string, bearer: string) {
  const url =
    `https://api.twitter.com/2/users/by/username/${encodeURIComponent(username)}` +
    `?user.fields=name,username,description,location,verified,created_at,public_metrics,url`;
  const data = await xApiFetchJson(url, bearer);
  if (!data?.data?.id) throw new Error(`X API: could not resolve user id for @${username}`);
  return data.data;
}

function mapTweetsToPosts(tweets: any[], includesUsers: any[] | undefined) {
  const users = new Map((includesUsers || []).map((u: any) => [u.id, u]));
  return (tweets || []).map((tweet: any) => {
    const user = users.get(tweet.author_id);
    const isReply = tweet.conversation_id && tweet.conversation_id !== tweet.id;
    return {
      text: tweet.text ?? "",
      date: tweet.created_at ?? "",
      author: user?.username ?? null,
      author_name: user?.name ?? null,
      author_bio: user?.description ?? null,
      author_location: user?.location ?? null,
      reply: Boolean(isReply),
      metrics: tweet.public_metrics ?? null,
      link: user?.username ? `https://x.com/${user.username}/status/${tweet.id}` : null,
    };
  });
}

async function executeXKeywordSearch(query: string, limit: number, mode: "Top" | "Latest") {
  const bearer = Deno.env.get("X_BEARER_TOKEN");
  if (!bearer) throw new Error("Missing X_BEARER_TOKEN");
  const m = query.match(/from:([A-Za-z0-9_]{1,15})/);
  const username = m?.[1] ?? null;
  // Prefer timeline when we can identify a user
  if (username) {
    const user = await resolveXUserByUsername(username, bearer);
    const exclude: string[] = [];
    if (query.includes("-is:retweet") || query.includes("exclude:retweets")) {
      exclude.push("retweets");
    }
    const max = Math.min(limit, 100);
    const params = new URLSearchParams({
      max_results: max.toString(),
      "tweet.fields": "created_at,conversation_id,public_metrics,author_id,referenced_tweets",
      expansions: "author_id",
      "user.fields": "username,name,description,location,verified",
    });
    if (exclude.length) params.set("exclude", exclude.join(","));
    const timelineUrl = `https://api.twitter.com/2/users/${user.id}/tweets?${params.toString()}`;
    const data = await xApiFetchJson(timelineUrl, bearer);
    const includesUsers = data.includes?.users?.length ? data.includes.users : [user];
    return mapTweetsToPosts(data.data || [], includesUsers);
  }
  // Fallback: keyword recent search
  const endpoint = "https://api.twitter.com/2/tweets/search/recent";
  const params = new URLSearchParams({
    query,
    max_results: Math.min(limit, 100).toString(),
    "tweet.fields": "created_at,conversation_id,public_metrics,author_id,referenced_tweets",
    expansions: "author_id",
    "user.fields": "username,name,description,location,verified",
  });
  if (mode === "Latest") params.set("sort_order", "recency");
  const url = `${endpoint}?${params.toString()}`;
  const data = await xApiFetchJson(url, bearer);
  return mapTweetsToPosts(data.data || [], data.includes?.users);
}

const handler = async (req: Request) => {
  try {
    if (req.method !== "POST") return json(405, { error: "Method Not Allowed – use POST" });
    const bodyText = await req.text();
    let body: ReqBody;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return json(400, { error: "Body was not valid JSON", bodyText });
    }
    const linkedinUrl = body.linkedin_url?.trim() || null;
    const xUrl = body.x_url?.trim() || null;
    if (!linkedinUrl && !xUrl) return json(400, { error: "Provide linkedin_url and/or x_url" });
    const xaiKey = Deno.env.get("XAI_API_KEY");
    if (!xaiKey) return json(500, { error: "Missing XAI_API_KEY environment variable" });
    /* -------------------------------------------------
      Tools definition for Grok (added browse_page)
    -------------------------------------------------- */
    const tools = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the public web for info (uses Serper). Use site: operators when possible.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              num_results: { type: "integer", default: 20 },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "x_keyword_search",
          description: "Official X API. Use from:username queries. Replies included. Exclude RTs with -is:retweet.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "integer", default: 50 },
              mode: { type: "string", enum: ["Top", "Latest"], default: "Latest" },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "browse_page",
          description: "Fetch and extract full text from a URL (HTML or PDF). Use for deep dives into profiles, CVs, or repos. Provide instructions for what to focus on (Grok will parse the raw text).",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string" },
              instructions: { type: "string", default: "Extract all relevant structured data like bio, experience, skills, projects." },
            },
            required: ["url"],
          },
        },
      },
    ];
    /* -------------------------------------------------
      System prompt (updated to force deeper tool use, especially for LinkedIn)
    -------------------------------------------------- */
    const systemPrompt = `
You are a professional people researcher.
RULES:
- Do NOT hallucinate.
- Use tool outputs as evidence.
- Output ONLY valid JSON. No markdown. No prose.
- If a field cannot be supported by evidence, set it to null/[] and add it to "uncertainties".
- ALWAYS use browse_page on the main LinkedIn profile URL, any LinkedIn post URLs found, CV PDFs, GitHub repos, and portfolio sites to extract full details (bios, roles, education, skills, projects, post texts). Do this even if seeds seem sufficient—snippets are incomplete.
- If seeds are incomplete (e.g., truncated bios or missing roles), use web_search for more (e.g., "site:linkedin.com/posts [name] activity"), then browse those URLs.
Input URLs:
- LinkedIn: ${linkedinUrl ?? "Not provided"}
- X: ${xUrl ?? "Not provided"}
You MUST use tools to gather info first, then output JSON persona with this exact structure:
{
  "name": "Full name",
  "age_or_approx": number | null,
  "location": "City, Country" | null,
  "headline_or_bio_short": "One-line summary" | null,
  "detailed_bio": string | null,
  "current_role": { "title": string | null, "company": string | null, "since": string | null, "description": string | null },
  "previous_roles": [{ "title": string, "company": string, "period": string, "description": string }],
  "education": [{ "school": string, "degree": string, "field": string, "years": string, "details": string }],
  "skills": [string],
  "interests": [string],
  "personality_traits": [string],
  "communication_style": string | null,
  "thinking_style": string | null,
  "how_they_think": string | null,
  "values_priorities": [string],
  "likely_motivations": [string],
  "potential_pain_points": [string],
  "worldview": string | null,
  "personal_life_insights": [string],
  "notable_achievements_or_projects": [{ "name": string, "description": string, "impact": string, "links": [string] }],
  "content_analysis": { "top_themes": [string], "examples": [{ "theme": string, "post_example": string, "date": string }] },
  "network": { "key_connections": [string], "influencers_followed": [string], "collaborations": [string] },
  "timeline": [{ "date": "YYYY-MM", "event": string }],
  "online_presence": {
    "linkedin": string | null,
    "x": string | null,
    "website": string | null,
    "other": [{ "platform": string, "url": string }]
  },
  "sources": [string],
  "uncertainties": [string]
}
`;
    /* -------------------------------------------------
      Seed data (MORE LinkedIn queries, plus name extraction and additional targeted queries)
    -------------------------------------------------- */
    const xHandle = extractXUsername(xUrl);
    const liSlug = extractLinkedInSlug(linkedinUrl);
    let seedX: any[] = [];
    let seedWeb: any[] = [];
    const web_queries: string[] = [];
    // X: timeline-based via from:handle
    if (xHandle) {
      seedX = await executeXKeywordSearch(`from:${xHandle} -is:retweet`, 100, "Latest");
    }
    // Web: expand LinkedIn search a lot (still only public/indexed stuff)
    if (liSlug) {
      // Existing queries
      web_queries.push(`site:linkedin.com/in/${liSlug}`);
      web_queries.push(`site:uk.linkedin.com/in/${liSlug}`);
      web_queries.push(`site:linkedin.com/in/${liSlug} (About OR bio OR headline)`);
      web_queries.push(`site:linkedin.com/in/${liSlug} (experience OR Experience)`);
      web_queries.push(`site:linkedin.com/in/${liSlug} (education OR Education)`);
      web_queries.push(`site:linkedin.com/in/${liSlug} (posts OR activity OR "recent activity")`);
      web_queries.push(`site:linkedin.com/posts "${liSlug}"`);
      web_queries.push(`site:linkedin.com/posts "${liSlug.replaceAll("-", " ")}"`);
      web_queries.push(`"${liSlug}" site:linkedin.com (Social Gravity OR Team Bath OR University of Bath)`);
      web_queries.push(`cache:linkedin.com/in/${liSlug}`);
      web_queries.push(`"${liSlug}" "Co-founder" "University of Bath"`);
      web_queries.push(`${liSlug} linkedin`);
      web_queries.push(`${liSlug} portfolio`);
      web_queries.push(`${liSlug} github`);
    } else if (linkedinUrl) {
      web_queries.push(`site:linkedin.com/in ${linkedinUrl}`);
    }
    for (const q of web_queries) {
      const r = await executeWebSearch(q, 20);
      seedWeb.push(...r.map((x: any) => ({ ...x, _query: q })));
    }
    seedWeb = dedupeByLink(seedWeb);

    // Extract full name from seedWeb
    let fullName = null;
    for (const item of seedWeb) {
      const titleMatch = item.title?.match(/^(.+?)\s*-\s*(Co-founder|Student|.+?)$/);
      if (titleMatch) {
        fullName = titleMatch[1].trim();
        break;
      }
      const snippetMatch = item.snippet?.match(/(.+?)\s*(Co-founder|Student|.+? at .+?)/);
      if (snippetMatch) {
        fullName = snippetMatch[1].trim();
        break;
      }
    }

    // If name found, add deeper queries (more LinkedIn-post focused)
    const additional_queries = [];
    if (fullName) {
      additional_queries.push(`"${fullName}" CV filetype:pdf`);
      additional_queries.push(`"${fullName}" resume filetype:pdf`);
      additional_queries.push(`"${fullName}" GitHub`);
      additional_queries.push(`site:github.com "${fullName}" repositories`);
      additional_queries.push(`"${fullName}" portfolio site`);
      additional_queries.push(`"${fullName}" projects`);
      additional_queries.push(`"${fullName}" skills`);
      // New: More for LinkedIn posts/activity
      additional_queries.push(`site:linkedin.com/posts "${fullName}" activity`);
      additional_queries.push(`"${fullName}" "recent activity" site:linkedin.com`);
      additional_queries.push(`site:linkedin.com/in ${liSlug} activity`);
    }
    for (const q of additional_queries) {
      const r = await executeWebSearch(q, 20);
      seedWeb.push(...r.map((x: any) => ({ ...x, _query: q })));
    }
    seedWeb = dedupeByLink(seedWeb);

    // New: Pre-browse key URLs for depth (e.g., LinkedIn profile, posts, portfolio, CV)
    const preBrowseUrls: string[] = [];
    if (linkedinUrl) preBrowseUrls.push(linkedinUrl); // Always browse main LinkedIn
    for (const item of seedWeb) {
      const link = item.link;
      if (link.includes('linkedin.com/posts') || link.includes('linkedin.com/in') || link.endsWith('.pdf') || link.includes('github.com') || link.includes('portfolio')) {
        preBrowseUrls.push(link);
      }
    }
    const uniquePreBrowse = [...new Set(preBrowseUrls.slice(0, 5))]; // Limit to 5 to avoid token overflow
    const preBrowseResults: any[] = [];
    for (const url of uniquePreBrowse) {
      try {
        const content = await executeBrowsePage(url, "Extract full bio, experience, education, skills, projects, post texts.");
        preBrowseResults.push({ url, content: content.slice(0, 20000) }); // Truncate for size
      } catch (e) {
        preBrowseResults.push({ url, error: (e as Error)?.message });
      }
    }

    let messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Use the tools to gather evidence, then output the persona JSON." },
      ...(seedWeb.length
        ? [{
            role: "tool",
            tool_call_id: "seed_web_search",
            content: JSON.stringify(seedWeb),
          }]
        : []),
      ...(seedX.length
        ? [{
            role: "tool",
            tool_call_id: "seed_x_search",
            content: JSON.stringify(seedX),
          }]
        : []),
      ...(preBrowseResults.length
        ? preBrowseResults.map((res, idx) => ({
            role: "tool",
            tool_call_id: `seed_browse_${idx}`,
            content: JSON.stringify(res),
          }))
        : []),
    ];
    /* -------------------------------------------------
      Grok loop (added handling for browse_page)
    -------------------------------------------------- */
    let content: string | null = null;
    for (let i = 0; i < 15; i++) { // Increased to 15 for more chances
      const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${xaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "grok-4",
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.2, // Slight increase for more tool exploration
          max_tokens: 8192, // Increased if API supports
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`xAI error ${response.status}: ${text}`);
      const data = JSON.parse(text);
      const message = data.choices[0].message;
      messages.push(message);
      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const args = JSON.parse(toolCall.function.arguments);
          let result: any;
          if (toolCall.function.name === "web_search") {
            result = await executeWebSearch(args.query, args.num_results ?? 20);
          } else if (toolCall.function.name === "x_keyword_search") {
            result = await executeXKeywordSearch(args.query, args.limit ?? 50, args.mode ?? "Latest");
          } else if (toolCall.function.name === "browse_page") {
            result = await executeBrowsePage(args.url, args.instructions ?? "");
          } else {
            result = { error: "Unknown tool" };
          }
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      } else {
        content = message.content;
        break;
      }
    }
    if (!content) throw new Error("No final content from model");
    let persona: any;
    try {
      persona = JSON.parse(content);
    } catch {
      const extracted = extractFirstJson(content);
      if (!extracted) throw new Error("Model did not return JSON");
      persona = JSON.parse(extracted);
    }
    return json(200, {
      linkedin_url: linkedinUrl,
      x_url: xUrl,
      persona,
      debug: {
        seeded_x_handle: xHandle,
        seeded_linkedin_slug: liSlug,
        extracted_full_name: fullName,
        seeded_x_posts: seedX.length,
        seeded_web_results: seedWeb.length,
        web_queries: [...web_queries, ...additional_queries],
        seedWeb, 
        seedX_sample: seedX.slice(0, 5),
        pre_browse_urls: uniquePreBrowse,
        pre_browse_results: preBrowseResults.map(r => ({ url: r.url, content_length: r.content?.length ?? 0, error: r.error })), // Truncated for debug
      },
    });
  } catch (e) {
    console.error(e);
    return json(500, {
      error: (e as Error)?.message ?? String(e),
      stack: (e as Error)?.stack ?? null,
    });
  }
};
Deno.serve({ hostname: "0.0.0.0", port }, handler);
