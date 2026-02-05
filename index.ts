// index.ts (Deno server setup for Railway)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Serper error ${res.status}: ${text}`);

  const data = JSON.parse(text);
  const organic = data.organic ?? [];
  return organic.slice(0, Math.min(num_results, 20)).map((r: any) => ({
    title: r.title ?? null,
    link: r.link ?? null,
    snippet: r.snippet ?? null,
  }));
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

serve(async (req) => {
  try {
    if (req.method !== "POST") return json(405, { error: "Method Not Allowed – use POST" });

    const body = (await req.json()) as ReqBody;
    const linkedinUrl = body.linkedin_url?.trim() || null;
    const xUrl = body.x_url?.trim() || null;

    if (!linkedinUrl && !xUrl) return json(400, { error: "Provide linkedin_url and/or x_url" });

    const xaiKey = Deno.env.get("XAI_API_KEY");
    if (!xaiKey) return json(500, { error: "Missing XAI_API_KEY environment variable" });

    /* -------------------------------------------------
      Tools definition for Grok
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
              num_results: { type: "integer", default: 10 },
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
              limit: { type: "integer", default: 20 },
              mode: { type: "string", enum: ["Top", "Latest"], default: "Latest" },
            },
            required: ["query"],
          },
        },
      },
    ];

    /* -------------------------------------------------
      System prompt (keep yours, but nudge: only fill what’s evidenced)
    -------------------------------------------------- */
    const systemPrompt = `
You are a professional people researcher.

RULES:
- Do NOT hallucinate.
- Use tool outputs as evidence.
- Output ONLY valid JSON. No markdown. No prose.
- If a field cannot be supported by evidence, set it to null/[] and add it to "uncertainties".

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
      Seed data (get as much as possible)
    -------------------------------------------------- */
    const xHandle = extractXUsername(xUrl);
    const liSlug = extractLinkedInSlug(linkedinUrl);

    let seedX: any[] = [];
    let seedWeb: any[] = [];

    // X: timeline-based via from:handle
    if (xHandle) {
      seedX = await executeXKeywordSearch(`from:${xHandle} -is:retweet`, 100, "Latest");
    }

    // Web: multiple Serper queries for LinkedIn + mentions
    const webQueries: string[] = [];
    if (liSlug) {
      webQueries.push(`site:linkedin.com/in/${liSlug}`);
      webQueries.push(`site:linkedin.com/in/${liSlug} "About"`);
      webQueries.push(`site:linkedin.com/in/${liSlug} "experience"`);
      webQueries.push(`site:linkedin.com/in/${liSlug} "education"`);
      webQueries.push(`"${liSlug}" site:linkedin.com`);
    } else if (linkedinUrl) {
      webQueries.push(`site:linkedin.com/in ${linkedinUrl}`);
    }

    // Also look for a personal site or GitHub
    if (liSlug) {
      webQueries.push(`${liSlug} portfolio`);
      webQueries.push(`${liSlug} github`);
    }

    for (const q of webQueries) {
      const r = await executeWebSearch(q, 10);
      seedWeb.push(...r);
    }

    seedWeb = dedupeByLink(seedWeb);

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
    ];

    /* -------------------------------------------------
      Grok loop
    -------------------------------------------------- */
    let content: string | null = null;

    for (let i = 0; i < 12; i++) {
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
          temperature: 0.1,
          max_tokens: 7000,
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
            result = await executeWebSearch(args.query, args.num_results ?? 10);
          } else if (toolCall.function.name === "x_keyword_search") {
            result = await executeXKeywordSearch(args.query, args.limit ?? 20, args.mode ?? "Latest");
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
        seeded_x_posts: seedX.length,
        seeded_web_results: seedWeb.length,
        web_queries: webQueries,
        seedWeb,            // ✅ add this
        seedX_sample: seedX.slice(0, 5)
      },
    });
  } catch (e) {
    console.error(e);
    return json(500, {
      error: (e as Error)?.message ?? String(e),
      stack: (e as Error)?.stack ?? null,
    });
  }
}, { port });
