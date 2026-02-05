// index.ts (Deno server setup for Railway)
import { serve } from "@std/http/server";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const port = Number(Deno.env.get("PORT") ?? "8080");

type ReqBody = {
  linkedin_url?: string;
  x_url?: string;
};

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

    /* -------------------------------------------------
       TOOL: Web search (Google – still brittle but kept)
    -------------------------------------------------- */
    async function executeWebSearch(query: string, num_results: number) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${num_results}`;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`Google fetch error ${response.status}`);
      }

      const html = await response.text();
      const document = new DOMParser().parseFromString(html, "text/html");
      if (!document) throw new Error("Failed to parse HTML");

      const results: any[] = [];
      const resultElements = document.querySelectorAll("div.g");

      for (const el of resultElements) {
        const title = el.querySelector("h3")?.textContent?.trim();
        const link = el.querySelector("a")?.getAttribute("href");
        const snippet =
          el.querySelector("span")?.textContent?.trim() ||
          el.textContent?.trim();

        if (title && link) results.push({ title, link, snippet });
      }

      return results.slice(0, num_results);
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

      const endpoint = "https://api.twitter.com/2/tweets/search/recent";

      const params = new URLSearchParams({
        query, // includes replies by default
        max_results: Math.min(limit, 100).toString(),
        "tweet.fields": "created_at,conversation_id,public_metrics,author_id",
        expansions: "author_id",
        "user.fields": "username,name",
      });

      if (mode === "Latest") {
        params.set("sort_order", "recency");
      }

      const res = await fetch(`${endpoint}?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${bearer}`,
          "User-Agent": "SocialGravityScraper/1.0",
        },
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`X API error ${res.status}: ${text}`);
      }

      const data = await res.json();

      const users = new Map(
        (data.includes?.users || []).map((u: any) => [u.id, u])
      );

      return (data.data || []).map((tweet: any) => {
        const user = users.get(tweet.author_id);
        return {
          text: tweet.text,
          date: tweet.created_at,
          author: user?.username ?? null,
          author_name: user?.name ?? null,
          reply: tweet.conversation_id !== tweet.id,
          metrics: {
            replies: tweet.public_metrics?.reply_count,
            reposts: tweet.public_metrics?.retweet_count,
          },
          link: user
            ? `https://x.com/${user.username}/status/${tweet.id}`
            : null,
        };
      });
    }

    /* -------------------------------------------------
       TOOL DEFINITIONS (unchanged)
    -------------------------------------------------- */
    const tools = [
      {
        type: "function",
        function: {
          name: "web_search",
          description:
            "Search Google for public info (LinkedIn, posts, bios).",
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
            "Official X API search. Includes replies. Use from:username queries.",
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
       GROK LOOP (unchanged logic)
    -------------------------------------------------- */
    const systemPrompt = `
You are a professional people researcher.

Use:
- x_keyword_search for X posts (replies INCLUDED)
- web_search for LinkedIn + indexed public content

Do NOT hallucinate. Output JSON only.
`;

    let messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Research this person and build the persona JSON now." },
    ];

    let content: string | null = null;

    for (let i = 0; i < 20; i++) {
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
          max_tokens: 8000,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = await response.json();
      const message = data.choices[0].message;
      messages.push(message);

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const args = JSON.parse(toolCall.function.arguments);
          let result;

          if (toolCall.function.name === "web_search") {
            result = await executeWebSearch(args.query, args.num_results ?? 10);
          } else if (toolCall.function.name === "x_keyword_search") {
            result = await executeXKeywordSearch(
              args.query,
              args.limit ?? 20,
              args.mode ?? "Latest"
            );
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

    return new Response(
      JSON.stringify(JSON.parse(content), null, 2),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error(e);
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}, { port });
