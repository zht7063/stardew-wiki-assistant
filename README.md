# Stardew wiki assistant

A mobile chat for asking Stardew Valley questions in Chinese. The assistant checks the [Chinese wiki](https://zh.stardewvalleywiki.com/) first and the [English wiki](https://stardewvalleywiki.com/) when a page is missing, then answers with links back to the pages it read.

P0 reads the live MediaWiki Action API. There is no vector index yet. Session history lives on the server; the phone sends a session id and the new message.

## Local development

Node.js 22.19 or newer (`@earendil-works/pi-ai` requires it).

```bash
npm install
cp .dev.vars.example .dev.vars
```

Put `DEEPSEEK_API_KEY` in `.dev.vars`. The key stays on the Worker and is never sent to the browser.

To preview with no key, set `MOCK_LLM=1`. Wiki requests stay live. A small script chooses the tool calls and writes the Chinese reply, which is enough to click through the UI and for the automated agent test.

Keep `WIKI_PROXY=http://127.0.0.1:8791` in `.dev.vars` (it is already in the example). Local `wrangler dev` sends outbound `fetch` over HTTP/1.1, and the wiki's Cloudflare check answers that with a challenge page. The same request over HTTP/2 succeeds. `npm run dev` starts a loopback proxy (`scripts/wiki-proxy.mjs`) that speaks HTTP/2 to `zh.stardewvalleywiki.com` and `stardewvalleywiki.com` only. Deployed Workers negotiate HTTP/2 on their own, so do not set `WIKI_PROXY` in production.

```bash
npm run dev
```

That builds the frontend, starts the wiki proxy, then runs `wrangler dev`. Open the local URL it prints (usually http://127.0.0.1:8787). After UI edits, run `npm run build:client` again or restart `npm run dev`.

```bash
npm test
npm run typecheck
```

## Deploy

1. `npx wrangler login`
2. Create the page cache and paste the id into `kv_namespaces[0].id` in `wrangler.jsonc`. The id in the repo only exists so local simulation can boot.

```bash
npx wrangler kv namespace create WIKI_CACHE
```

3. Secrets:

```bash
npx wrangler secret put DEEPSEEK_API_KEY
# Optional. When set, the phone must enter the same passphrase before a chat can spend the key.
npx wrangler secret put APP_PASSWORD
```

4. `npm run deploy`

`DEEPSEEK_MODEL` defaults to `deepseek-flash` on `https://api.deepseek.com`. `deepseek-chat` was removed from that API on 2026-07-24; `deepseek-flash` is the current non-thinking chat model on the same endpoint. Change `vars.DEEPSEEK_MODEL` to point elsewhere.

The `ChatStore` Durable Object keeps sessions and the full tool transcript in SQLite, so follow-ups still have context. P0 stores every chat for this install in one object (no accounts). Set `APP_PASSWORD` before sharing the URL.

## Layout

- `src/worker` — `POST /api/chat` streams tokens, tool status, and citations as SSE. Static files are Workers assets. `/api/*` hits the Worker first.
- `src/agent` — tool loop from [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi), DeepSeek via [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi). No pi-coding-agent file or shell tools.
- `src/wiki` — `search_wiki`, `get_page`, `map_title`. Chinese pages first, English via langlinks or the same title when Chinese is missing. Page HTML (templates already expanded, so item names are Chinese) is cleaned into infobox fields and markdown tables. Page fetches are cached in KV. Requests send a descriptive User-Agent. Locally they go through the HTTP/2 proxy described above.
- `src/client` — React PWA: token streaming, a “正在翻阅 wiki…” status while tools run, starter chips, source cards, tables, safe areas, new chat, and a recent-session list.

Parsing follows the infobox and table cleanup in [farming-game-mcp](https://github.com/cbhl/farming-game-mcp) and the API notes in [sdv-mcp](https://github.com/vehemont/sdv-mcp): this wiki is MediaWiki 1.35, TextExtracts is not installed, and `rest.php` returns nothing useful, so the Action API plus short keywords is the reliable path.

Wiki text is [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). Answers cite the page. This app is not affiliated with ConcernedApe and does not ship game sprites.

## What works, and what is next

Works now:

- Multi-turn Chinese answers, with history stored on the server
- Search, page read, and zh↔en title mapping before the answer
- Citation cards that open the wiki
- `MOCK_LLM=1` for local preview without a key
- Tests for HTML cleanup and the agent loop with a mocked model

Not in P0:

- A vector index over a wiki dump, which would help “every spring fish” questions and cut live API calls
- A session per device instead of one shared notebook
- Mapping leftover English `{{Name}}` ids inside long body text (infobox fields already use the rendered Chinese names)
- Smarter section picking so a long page is not cut off after a few thousand characters
