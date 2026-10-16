# Stardew wiki assistant

A mobile chat for asking Stardew Valley questions in Chinese. Answers come from an offline copy of the [Chinese wiki](https://zh.stardewvalleywiki.com/) and the [English wiki](https://stardewvalleywiki.com/). Citation cards still open the original pages.

The Worker does not fetch the wiki. Both hosts sit behind Cloudflare and answer Worker traffic with a 403 challenge page, while the same API calls succeed from a normal machine. A script on that machine (or GitHub Actions, when the runner is not challenged) pulls the pages, cleans them, and uploads them to D1 and Vectorize. The phone sends a session id and the new message; history stays in a Durable Object.

## Local development

Node.js 22.19 or newer (`@earendil-works/pi-ai` requires it).

```bash
npm install
cp .dev.vars.example .dev.vars
```

Put `DEEPSEEK_API_KEY` in `.dev.vars`, or set `MOCK_LLM=1` to preview without a key. The key stays on the Worker and is never sent to the browser. `MOCK_LLM=1` still reads the index; only the narrator is scripted.

```bash
npm test
npm run typecheck
npm run dev
```

`npm run dev` builds the frontend and starts `wrangler dev` (usually http://127.0.0.1:8787). After UI edits, run `npm run build:client` again. Until you ingest, search tells the model the index is empty.

A local sample (no Cloudflare account) writes `.data/wiki.sqlite`:

```bash
npm run ingest -- --target local --langs zh --limit 40
```

That talks to the wiki over HTTP/2. If you see a Cloudflare challenge, wait and retry from a residential network. `.data/` is gitignored.

## Index

About 1,996 Chinese articles and 2,003 English articles (main namespace, non-redirects, measured October 2026). Ingest:

1. Lists titles, then revision ids and langlinks, 15 titles at a time.
2. Parses a page only when `lastrevid` changed. Rendered HTML is cleaned with the same infobox and table parser as before (templates are already expanded, so item names are Chinese).
3. Stores the page in D1 and one 1024-dim embedding in Vectorize (`@cf/baai/bge-m3`).
4. Waits 250ms between wiki calls and sends a descriptive User-Agent.

Search in the Worker uses FTS5 trigrams (this is what makes Chinese keywords match) and, when Workers AI responds within 2.5s, merges the nearest vectors. Chinese is preferred. If that side is thin, English pages are included and `get_page` follows langlinks. There is no live wiki fallback: a blocked fetch only adds a failed round trip.

`WIKI_CACHE` is still bound to the production namespace `11d435912c9b4141be03abdd278f57cc`. The chat path does not read it. Local `wrangler dev` simulates that namespace, so the real id is fine locally.

## Deploy and first ingest

1. `npx wrangler login`
2. Create the database and paste the printed `database_id` over `00000000-0000-0000-0000-000000000000` in `wrangler.jsonc`:

```bash
npx wrangler d1 create stardew-wiki
```

3. Create the vector index (1024 dimensions, cosine). The name `stardew-wiki` matches `vectorize[0].index_name`.

```bash
npx wrangler vectorize create stardew-wiki --dimensions=1024 --metric=cosine
```

4. Create a Cloudflare API token at https://dash.cloudflare.com/profile/api-tokens (Create Custom Token). Account permissions:

   - **D1: Edit**
   - **Workers AI: Read** (running a model). If a run returns 403, change this to Edit.
   - **Vectorize: Edit**

   Account resources: the account that owns the Worker. Copy the account id from the dashboard sidebar or `npx wrangler whoami`.

5. Apply the schema and ingest from your own computer (HTTP/2). The first run is on the order of 30–50 minutes because of the pause between wiki calls. Later runs skip unchanged pages.

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler d1 execute stardew-wiki --remote --file schema/wiki.sql
npm run ingest -- --target remote
```

`WIKI_DB_ID` overrides the id in `wrangler.jsonc` if you have not committed it yet. `--skip-vectors` writes D1 only. `--limit 50` caps pages per language.

6. Secrets and deploy:

```bash
npx wrangler secret put DEEPSEEK_API_KEY
# Optional. When set, the phone must enter the same passphrase before a chat can spend the key.
npx wrangler secret put APP_PASSWORD
npm run deploy
```

`DEEPSEEK_MODEL` defaults to `deepseek-flash` on `https://api.deepseek.com`. `deepseek-chat` was removed from that API on 2026-07-24. Change `vars.DEEPSEEK_MODEL` to point elsewhere.

Weekly refresh is `.github/workflows/ingest.yml` (Sundays 18:00 UTC, or run it by hand). Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. `WIKI_DB_ID` is optional when `wrangler.jsonc` already has the real database id. Actions runners are datacenter IPs and may get the same Cloudflare challenge as Workers. If the job fails with “Cloudflare challenge”, run the same `npm run ingest -- --target remote` command locally. The script exits on the first challenge instead of retrying for the whole corpus.

### Size and cost

Roughly 4,000 pages, one vector each:

| Piece | Size | Cost |
| --- | --- | --- |
| D1 text | about 150 MB | A 40-page local sample was 1.5 MB on disk, so ~4,000 pages land near 150 MB with the full-text index. That is inside the 5 GB included on Workers Free and Paid. A full write is a few tens of thousands of rows, under the free 100k writes/day. Chat reads are a handful of rows per question. |
| Vectorize | about 4,000 × 1024 ≈ 4.1 million stored dimensions | Inside the free 5 million stored dimensions and the paid included 10 million. Queried dimensions for a personal phone are far under 30 million/month. |
| Workers AI embeddings | about 2–4 million input tokens for a full rebuild | `@cf/baai/bge-m3` is $0.0118 per million input tokens, so a full rebuild is well under $0.10. The free allotment is 10,000 Neurons/day. Weekly runs embed only changed pages. |

If `wrangler vectorize create` is rejected on a Free plan, ingest with `--skip-vectors` and remove the `vectorize` and `ai` blocks from `wrangler.jsonc` before deploy. Keyword search still answers named questions (阿比盖尔, 草莓, 古代种子).

The `ChatStore` Durable Object keeps sessions and the tool transcript in SQLite, so follow-ups still have context. Every chat for this install shares one object (no accounts). Set `APP_PASSWORD` before sharing the URL.

## Layout

- `src/worker` — `POST /api/chat` streams tokens, tool status, and citations as SSE. Static files are Workers assets. `/api/*` hits the Worker first.
- `src/agent` — tool loop from [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi), DeepSeek via [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi). No pi-coding-agent file or shell tools.
- `src/wiki` — `search_wiki`, `get_page`, `map_title` read D1 (trigram full text) and Vectorize. Chinese pages first, English via langlinks. Citations use the original wiki URLs.
- `src/ingest` — Action API pull, cleaner, D1 upload, embeddings. Not part of the Worker bundle.
- `src/client` — React PWA: token streaming, a “正在翻阅 wiki…” status while tools run, starter chips, source cards, tables, safe areas, new chat, and a recent-session list.

Parsing follows the infobox and table cleanup in [farming-game-mcp](https://github.com/cbhl/farming-game-mcp) and the API notes in [sdv-mcp](https://github.com/vehemont/sdv-mcp): this wiki is MediaWiki 1.35, TextExtracts is not installed, and `rest.php` returns nothing useful, so the Action API plus short keywords is the reliable path.

Wiki text is [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). Answers cite the page. This app is not affiliated with ConcernedApe and does not ship game sprites.

## What works, and what is next

Works now:

- Offline index: Chinese and English pages, langlinks, infoboxes, markdown tables
- Keyword search that handles Chinese, plus vector search when embeddings are loaded
- Multi-turn Chinese answers, with history stored on the server
- Citation cards that open the wiki
- `MOCK_LLM=1` for local preview without a key
- Tests for HTML cleanup, ingest, retrieval, and the agent loop with a mocked model

Not in this pass:

- A session per device instead of one shared notebook
- Mapping leftover English `{{Name}}` ids inside long body text (infobox fields already use the rendered Chinese names)
- Smarter section picking so a long page is not cut off after a few thousand characters
- Live wiki fetches from the Worker (removed; they 403 and only add delay)
