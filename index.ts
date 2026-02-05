// index.ts (Deno server setup for Railway)
import { serve } from "@std/http/server";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";



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

    const apiKey = Deno.env.get("XAI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Missing XAI_API_KEY environment variable" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Tool implementations (using built-in fetch and DOMParser)
    async function executeWebSearch(query: string, num_results: number) {
      const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${num_results}`;
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" },
      });
      if (!response.ok) {
        throw new Error(`Google fetch error ${response.status}`);
      }
      const html = await response.text();
      const parser = new DOMParser();
      const document = parser.parseFromString(html, "text/html");
      if (!document) throw new Error("Failed to parse HTML");
      const results = [];
      const resultElements = document.querySelectorAll("div.g");
      for (const el of resultElements) {
        const title = el.querySelector("h3")?.textContent?.trim();
        const link = el.querySelector("a")?.getAttribute("href");
        const snippet = el.querySelector("span.st")?.textContent?.trim() || el.querySelector("div")?.textContent?.trim();
        if (title && link) results.push({ title, link, snippet });
      }
      return results.slice(0, num_results);
    }

    async function executeXKeywordSearch(query: string, limit: number, mode: string) {
      const nitterInstance = "https://nitter.poast.org";
      const searchMode = mode.toLowerCase() === "latest" ? "&f=tweets" : "";
      const url = `${nitterInstance}/search?f=tweets${searchMode}&q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36" },
      });
      if (!response.ok) {
        throw new Error(`Nitter fetch error ${response.status}`);
      }
      const html = await response.text();
      const parser = new DOMParser();
      const document = parser.parseFromString(html, "text/html");
      if (!document) throw new Error("Failed to parse HTML");
      const posts = [];
      const tweetElements = document.querySelectorAll(".timeline-item .tweet-content");
      for (let i = 0; i < tweetElements.length && i < limit; i++) {
        const el = tweetElements[i];
        const text = el.textContent?.trim();
        const dateElem = el.closest(".tweet")?.querySelector(".tweet-date a");
        const date = dateElem?.getAttribute("title") || dateElem?.textContent?.trim() || "";
        const link = nitterInstance + (el.closest(".tweet")?.querySelector(".tweet-link")?.getAttribute("href") || "");
        const author = el.closest(".tweet")?.querySelector(".fullname")?.textContent?.trim() || "";
        if (text) posts.push({ text, date, link, author });
      }
      return posts;
    }

    // Tools definition (same as before)
    const tools = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: `Search Google for public info (e.g., for LinkedIn: use site:linkedin.com/in/[slug] + keywords for posts/bio). Keep queries broad. Chain for depth.`,
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query with operators." },
              num_results: { type: "integer", default: 10, description: "Max 20." },
            },
            required: ["query"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "x_keyword_search",
          description: `Deep search on X using advanced operators (e.g., from:@user for full feed, since/until for chronology). Analyze for persona insights.`,
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Advanced X query (e.g., from:@elalvarobalbin)." },
              limit: { type: "integer", default: 20 },
              mode: { type: "string", enum: ["Top", "Latest"], default: "Latest" },
            },
            required: ["query"],
          },
        },
      },
    ];

    // System prompt (unchanged for deep persona)
    const systemPrompt = `
You are a professional people researcher. Given LinkedIn and/or X URLs, use tools to gather maximum public info: profiles, posts, interactions, etc. Prioritize x_keyword_search for full/deep X feed analysis (chain queries for older posts, themes, tones). For LinkedIn, use web_search with site:linkedin.com to pull indexed content (headlines, about, education, posts).

Do NOT hallucinate. Only verifiable sources. Note uncertainties.
Infer deeply: Personality from tone, thinking from approaches in posts, worldview from opinions.

Input URLs:
- LinkedIn: ${linkedinUrl ?? "Not provided"}
- X: ${xUrl ?? "Not provided"}

Extract name/username, then chain tools for depth (e.g., multiple x_keyword_search with since/until for timeline).

Output ONLY JSON persona with structure:

{
  "name": "Full name",
  "age_or_approx": number | null,
  "location": "City, Country" | null,
  "headline_or_bio_short": "One-line summary",
  "detailed_bio": "Full bio text",
  "current_role": { "title": "...", "company": "...", "since": "...", "description": "..." },
  "previous_roles": [{title: "...", company: "...", period: "...", description: "..."}],
  "education": [{school: "...", degree: "...", field: "...", years: "...", details: "..."}],
  "skills": ["..."],
  "interests": ["..."],
  "personality_traits": ["e.g., entrepreneurial, optimistic"],
  "communication_style": "e.g., direct and motivational",
  "thinking_style": "e.g., systems-oriented, fast-iterative",
  "how_they_think": "Deep analysis: e.g., approaches problems via simulation/AI, values speed from posts",
  "values_priorities": ["..."],
  "likely_motivations": ["e.g., building impactful startups"],
  "potential_pain_points": ["e.g., frustration with slow academia"],
  "worldview": "e.g., AI will transform content, with quotes",
  "personal_life_insights": ["e.g., family mentions, hobbies"],
  "notable_achievements_or_projects": [{name: "...", description: "...", impact: "...", links: ["..."]}],
  "content_analysis": { "top_themes": ["..."], "examples": [{theme: "...", post_example: "...", date: "..."}] },
  "network": { "key_connections": ["..."], "influencers_followed": ["..."], "collaborations": ["..."] },
  "timeline": [{date: "YYYY-MM", event: "..."}],
  "online_presence": {
    "linkedin": "...",
    "x": "...",
    "website": null,
    "other": [{platform: "...", url: "..."}]
  },
  "sources": ["..."],
  "uncertainties": ["..."]
}

Use tools to gather, then output JSON.
`;

    let messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Research this person and build the persona JSON now." },
    ];

    let content: string | null = null;
    const maxIterations = 20;

    for (let i = 0; i < maxIterations; i++) {
      const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
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
        const errText = await response.text();
        throw new Error(`xAI API error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const message = data.choices[0].message;

      messages.push(message);

      if (message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          console.log(`Tool call: ${functionName} with args: ${JSON.stringify(args)}`);
          let toolResult;

          if (functionName === "web_search") {
            toolResult = await executeWebSearch(args.query, args.num_results || 10);
          } else if (functionName === "x_keyword_search") {
            toolResult = await executeXKeywordSearch(args.query, args.limit || 20, args.mode || "Latest");
          } else {
            toolResult = { error: "Unknown tool" };
          }

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: functionName,
            content: JSON.stringify(toolResult),
          });
        }
      } else {
        content = message.content;
        break;
      }
    }

    if (!content) {
      throw new Error("No final content after max iterations");
    }

    let persona;
    try {
      persona = JSON.parse(content);
    } catch {
      throw new Error("Invalid JSON from Grok");
    }

    return new Response(
      JSON.stringify({
        linkedin_url: linkedinUrl || null,
        x_url: xUrl || null,
        persona,
      }, null, 2),
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