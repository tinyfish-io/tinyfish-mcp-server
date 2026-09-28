# TinyFish MCP Examples

Common workflows people run with the TinyFish MCP server, and the prompts that start them. Paste any
prompt into an MCP client (Claude Code, Claude Desktop, Cursor, VS Code, Codex, ChatGPT and others)
once TinyFish is connected. The assistant picks the tools. The calls shown here are what each prompt
typically resolves to.

> **Using Claude or ChatGPT in the browser or desktop app?** Skip the setup and add the official
> TinyFish plugin for **[Claude](https://claude.ai/directory/tinyfish)** or **[ChatGPT](https://chatgpt.com/plugins/plugin_asdk_app_695325bae7348191b58ae9349a963d22)** in one click. It bundles
> these tools with ready-made skills and safety rules.

New to TinyFish? Connect your client first with the
**[MCP Integration guide](https://docs.tinyfish.ai/mcp-integration)**. Every tool and parameter is
listed in [tools.md](tools.md).

| I want to… | Start with | Cost |
|---|---|---|
| Answer a question from the live web | `search` → `fetch_content` | Free |
| Read, summarize or extract from known URLs | `fetch_content` | Free |
| Click, fill forms, log in or navigate a site | `run_web_automation` | Per step |
| Drive a browser myself with Playwright/Puppeteer | `create_browser_session` | Per browser-minute |
| Get told when a page or topic changes | `create_monitor` | Per completed run |

Current rates are on the [MCP Integration](https://docs.tinyfish.ai/mcp-integration#rates) page.

## Research & grounded answers

Use `search` to find sources, then `fetch_content` to read them. Both are free.

```text
What changed in the latest Node.js LTS release? Cite sources.
```

```text
Find research papers on retrieval-augmented generation published since 2023 and summarize the three most cited.
```

```json
{ "query": "retrieval-augmented generation", "domain_type": "research_paper", "pub_year_min": 2023 }
```

```text
What's the news on EU AI Act enforcement from the past 24 hours?
```

```json
{ "query": "EU AI Act enforcement", "domain_type": "news", "recency_minutes": 1440 }
```

```text
Search only GitHub and arXiv for open-source web agent benchmarks.
```

```json
{ "query": "open-source web agent benchmark", "include_domains": "github.com,arxiv.org" }
```

## Reading docs & pages

`fetch_content` renders pages in a real browser, so it handles JavaScript-heavy sites. It reads up to
10 URLs at once.

```text
Fetch https://docs.stripe.com/api/charges and summarize the API parameters.
```

```text
Read these five blog posts and give me a one-paragraph summary of each.
```

```text
Get just the main article from this page, without comments or the newsletter box.
```

```json
{
  "urls": ["https://example.com/post"],
  "format": "markdown",
  "include_selectors": ["article"],
  "exclude_selectors": [".comments", ".newsletter-signup"],
  "links": false,
  "image_links": false,
  "page_metadata": false
}
```

## SEO & site audits

With `page_metadata`, `fetch_content` also returns the canonical URL, robots directive, Open Graph
tags, Twitter card and other meta tags. `links` lists each page's outbound URLs.

```text
Pull the title, meta description, canonical URL and Open Graph tags from these 10 URLs and flag anything missing.
```

```json
{
  "urls": ["https://example.com/", "https://example.com/pricing"],
  "format": "markdown",
  "page_metadata": true,
  "links": false,
  "image_links": false
}
```

```text
List every link on our homepage and tell me which ones point off-site.
```

```text
Search for "best web scraping API" and tell me which domains rank on the first page and how they title their pages.
```

## Competitive & pricing research

```text
Compare the pricing tiers on the pricing pages of Vercel, Netlify and Cloudflare Pages in a table.
```

```text
Scrape the pricing pages from these 5 competitor websites at the same time.
```

When pricing sits behind tabs, toggles or a "monthly/annual" switch, the assistant moves to
`run_web_automation`:

```text
On example.com/pricing, switch to annual billing and extract every plan's name, price and included seats.
```

## Web automation

`run_web_automation` takes a URL and a natural-language goal. Pass `output_schema` to get structured
JSON back. A run can take several minutes. If one times out, the assistant should check `get_run` or
`list_runs` and not start it again.

```text
Go to news.ycombinator.com, open the top story, and summarize the discussion in its comments.
```

```text
Search example-store.com for "standing desk" and return the first 10 results with name, price and rating.
```

```json
{
  "url": "https://example-store.com",
  "goal": "Search for 'standing desk' and extract the first 10 results",
  "session_id": "<new uuid v4>",
  "output_schema": {
    "type": "object",
    "properties": {
      "results": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "price": { "type": "number" },
            "rating": { "type": "number" }
          }
        }
      }
    }
  }
}
```

```text
Fill out the contact form on example.com with my name and email and a note asking for a demo.
```

```text
Run this in the background: collect every job posting on example.com/careers with title, team and location.
```

The last prompt asks explicitly for background execution, so it uses `run_web_automation_async` and
polls with `get_run`. For sites with bot protection, add "use stealth mode" to the prompt to get
`browser_profile: "stealth"`, or "use a US proxy" to get `proxy_config`.

## Signed-in workflows (Browser Context Profiles)

Sign in once by hand, then reuse that session in later runs without handing passwords to the agent.

```text
Set up a profile for my Salesforce account so I can sign in once and reuse it.
```

This creates a profile with `create_profile` and opens a live browser with
`start_profile_setup_session`. You sign in through the returned `viewer_url`, and
`save_profile_setup_session` then stores the cookies and storage on the profile.

```text
Use my saved Salesforce profile to summarize the account health dashboard.
```

```json
{
  "url": "https://app.example.com/dashboard",
  "goal": "Summarize the account health dashboard",
  "session_id": "<new uuid v4>",
  "use_profile": true,
  "use_vault": true
}
```

`use_vault` lets the run sign back in with saved vault credentials if the stored session has expired.

## Remote browsers for Playwright, Puppeteer & Selenium

```text
Create a browser session on https://example.com so I can control it with Playwright.
```

`create_browser_session` returns CDP connection details for a stealth Chrome instance in the cloud.
Close it with `close_browser_session` when you're done so it doesn't keep billing until its inactivity
timeout.

## Monitoring pages & topics

Monitors run on a cron schedule, return a baseline immediately and can post each result to a webhook.

```text
Check this product page every weekday at 9am New York time and tell me when the price drops.
```

```json
{
  "type": "fetch",
  "config": { "url": "https://example.com/product/123" },
  "schedule_cron": "CRON_TZ=America/New_York 0 9 * * 1-5",
  "purpose": "the price drops"
}
```

```text
Send me daily news about AI agent frameworks.
```

```json
{
  "type": "search",
  "config": { "query": "AI agent frameworks", "recency_minutes": 1440 },
  "schedule_cron": "0 8 * * *"
}
```

```text
Which monitors do I have? Pause the pricing one.
```

## Account

```text
What's my TinyFish wallet balance and what do automation steps cost me?
```

```text
Show me the searches I ran last week.
```

```text
What should I try next with TinyFish?
```

The last prompt calls `guide_next_step`, which suggests an onboarding step based on your usage.

## More

- MCP Integration (client setup, OAuth, rates, troubleshooting): [docs.tinyfish.ai/mcp-integration](https://docs.tinyfish.ai/mcp-integration)
- Full documentation: [docs.tinyfish.ai](https://docs.tinyfish.ai)
- Tool reference: [tools.md](tools.md)
