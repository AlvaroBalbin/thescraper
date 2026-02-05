// index.ts (Deno server setup for Railway)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const port = Number(Deno.env.get("PORT") ?? "8080");

type ReqBody = {
  linkedin_url?: string;
  x_url?: string;
};

function extractXUsername(xUrl?: string | null): string | null {
  if (!xUrl) return null;
  try {
    const u = new URL(xUrl);
    if (!u.hostname.includes("x.com") && !u.hostname.includes("twitter.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const handle = parts[0].replace("@", "");
    return handle || null;
  } catch {
    return null;
  }
}

function extractLinkedInSlug(linkedinUrl?: string | null): string | null {
  if (!linkedinUrl) return null;
  try {
    const u = new URL(linkedinUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    // expect: /in/<slug>/
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

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed – use POST", { status: 405 });
    }

    const body = (await req.json()) as ReqBody;
    const linkedinUrl = body.linkedin_url?.trim();
    const xUrl = body.x_url?.trim();

    if (!linkedinUrl && !xUrl) {
      return new Response(
        JSON.stringify({ error: "Provide at least one URL (linkedin_url or x_url)" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const xaiKey = Deno.env.get("XAI_API_KEY");
    if (!xaiKey) {
      return new Response(
        JSON.stringify({ error: "Missing XAI_API_KEY environment variable" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    async function xApiFetchJson(url: string, bearer: string) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      "User-Agent": "SocialGravityScraper/1.0",
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`X API error ${res.status}: ${text}`);
  }

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
  return data.data; // {id, name, username, ...}
}


    /* -------------------------------------------------
      TOOL: Web search (still brittle; we’ll seed it carefully)
    -------------------------------------------------- */
    async function executeWebSearch(query: string, num_results: number) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${num_results}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
          "Accept-Language": "en-GB,en;q=0.9",
        },
      });

      if (!response.ok) {
        const txt = await response.text().catch(() => "");
        throw new Error(`Google fetch error ${response.status}: ${txt.slice(0, 200)}`);
      }

      const html = await response.text();
      const document = new DOMParser().parseFromString(html, "text/html");
      if (!document) throw new Error("Failed to parse HTML");

      const results: any[] = [];
      const resultElements = document.querySelectorAll("div.g");

      for (const el of resultElements) {
        const title = el.querySelector("h3")?.textContent?.trim();
        const link = el.querySelector("a")?.getAttribute("href");

        // Google changes markup constantly. Be forgiving.
        const snippet =
          el.querySelector("[data-sncf]")?.textContent?.trim() ||
          el.querySelector("span")?.textContent?.trim() ||
          el.textContent?.trim();

        if (title && link) results.push({ title, link, snippet });
      }

      return results.slice(0, Math.min(num_results, 20));
    }

    /* -------------------------------------------------
      TOOL: X API v2 (official, replies included)
    -------------------------------------------------- */
    async function executeXKeywordSearch(
  query: string,
  limit: number,
  mode: "Top" | "Latest"
) {
  const bearer = Deno.env.get("X_BEARER_TOKEN");
  if (!bearer) throw new Error("Missing X_BEARER_TOKEN");

  // We mainly expect queries like: "from:elalvarobalbin -is:retweet"
  // Parse the handle if present; otherwise fall back to recent search.
  const m = query.match(/from:([A-Za-z0-9_]{1,15})/);
  const username = m?.[1] ?? null;

  // Helper: normalize tweet->post objects (includes replies)
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

  // ✅ Prefer timeline (way more reliable than recent search)
  if (username) {
    const user = await resolveXUserByUsername(username, bearer);

    // Build timeline query
    // - Exclude retweets if requested
    const exclude: string[] = [];
    if (query.includes("-is:retweet") || query.includes("exclude:retweets")) {
      exclude.push("retweets");
    }
    // (We do NOT exclude replies because you want replies included)

    const max = Math.min(limit, 100);

    const params = new URLSearchParams({
      max_results: max.toString(),
      "tweet.fields": "created_at,conversation_id,public_metrics,author_id,referenced_tweets",
      expansions: "author_id",
      "user.fields": "username,name,description,location,verified",
    });

    if (exclude.length) params.set("exclude", exclude.join(","));

    // NOTE: timeline endpoint does not support sort_order; it’s basically reverse-chronological.
    const timelineUrl = `https://api.twitter.com/2/users/${user.id}/tweets?${params.toString()}`;
    const data = await xApiFetchJson(timelineUrl, bearer);

    // Inject the resolved user into includes so mapping has author info even if expansions missing
    const includesUsers = data.includes?.users?.length ? data.includes.users : [user];

    return mapTweetsToPosts(data.data || [], includesUsers);
  }

  // Fallback: if no from:handle, use recent search (still useful for keyword queries)
  const endpoint = "https://api.twitter.com/2/tweets/search/recent";
  const params = new URLSearchParams({
    query,
    max_results: Math.min(limit, 100).toString(),
    "tweet.fields": "created_at,conversation_id,public_metrics,author_id,referenced_tweets",
    expansions: "author_id",
    "user.fields": "username,name,description,location,verified",
  });

  if (mode === "Latest") params.set("sort_order", "recency");
  // "Top" just leaves default relevance ranking

  const url = `${endpoint}?${params.toString()}`;
  const data = await xApiFetchJson(url, bearer);

  return mapTweetsToPosts(data.data || [], data.includes?.users);
}


    /* -------------------------------------------------
      TOOL DEFINITIONS
    -------------------------------------------------- */
    const tools = [
      {
        type: "function",
        function: {
          name: "web_search",
          description:
            "Search the public web for info. Use site: operators when possible.",
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
          description:
            "Official X API search (recent). Includes replies unless excluded in query. Use from:username queries.",
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
      SYSTEM PROMPT (your detailed one, but strengthened)
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
      Seed tool calls (THIS IS THE BIG FIX)
    -------------------------------------------------- */
    const xHandle = extractXUsername(xUrl);
    const liSlug = extractLinkedInSlug(linkedinUrl);

    let seedX: any[] = [];
    let seedWeb: any[] = [];

    if (xHandle) {
      // Include replies, exclude RTs
      seedX = await executeXKeywordSearch(`from:${xHandle} -is:retweet`, 50, "Latest");
    }

    if (liSlug) {
      seedWeb = await executeWebSearch(`site:linkedin.com/in/${liSlug}`, 10);
    } else if (linkedinUrl) {
      seedWeb = await executeWebSearch(`site:linkedin.com/in ${linkedinUrl}`, 10);
    }

    let messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Use the tools to gather evidence, then output the persona JSON." },

      // seed results as if tools were called (so Grok has data immediately)
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
      GROK LOOP (still supports more tool calls)
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
          max_tokens: 6000,
        }),
      });

      if (!response.ok) throw new Error(await response.text());

      const data = await response.json();
      const message = data.choices[0].message;
      messages.push(message);

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const args = JSON.parse(toolCall.function.arguments);
          let result: any;

          if (toolCall.function.name === "web_search") {
            result = await executeWebSearch(args.query, args.num_results ?? 10);
          } else if (toolCall.function.name === "x_keyword_search") {
            result = await executeXKeywordSearch(
              args.query,
              args.limit ?? 20,
              args.mode ?? "Latest"
            );
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

    if (!content) throw new Error("No final content");

    // Robust JSON parse (handles “Unexpected token W”)
    let persona: any = null;
    try {
      persona = JSON.parse(content);
    } catch {
      const extracted = extractFirstJson(content);
      if (extracted) persona = JSON.parse(extracted);
      else throw new Error("Model did not return JSON");
    }

    return new Response(
      JSON.stringify(
        {
          linkedin_url: linkedinUrl || null,
          x_url: xUrl || null,
          persona,
          debug: {
            seeded_x_handle: xHandle,
            seeded_linkedin_slug: liSlug,
            seeded_x_posts: seedX.length,
            seeded_web_results: seedWeb.length,
          },
        },
        null,
        2
      ),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({ error: (e as Error).message || "Internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}, { port });
