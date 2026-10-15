/**
 * Local HTTP/2 bridge for wiki fetches.
 *
 * `wrangler dev` speaks HTTP/1.1 on outbound fetch. The Stardew wiki's
 * Cloudflare bot check answers that with a challenge page, while the same
 * request over HTTP/2 succeeds. Production Workers negotiate HTTP/2, so this
 * process is only for local dev. It listens on loopback and only forwards
 * the two wiki hosts.
 */
import http from "node:http";
import { Agent, fetch as undiciFetch } from "undici";

const port = Number(process.env.WIKI_PROXY_PORT || 8791);
const agent = new Agent({ allowH2: true, connect: { timeout: 20_000 } });
const allowedHosts = new Set(["zh.stardewvalleywiki.com", "stardewvalleywiki.com"]);

const server = http.createServer(async (req, res) => {
  try {
    const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
    const target = incoming.searchParams.get("url");
    if (!target) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("missing url");
      return;
    }
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("host not allowed");
      return;
    }
    const userAgent = Array.isArray(req.headers["user-agent"])
      ? req.headers["user-agent"][0]
      : req.headers["user-agent"];
    const accept = Array.isArray(req.headers.accept) ? req.headers.accept[0] : req.headers.accept;
    const upstream = await undiciFetch(parsed, {
      dispatcher: agent,
      headers: {
        "User-Agent": userAgent || "StardewWikiAssistant/0.1",
        Accept: accept || "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : "proxy failed");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`wiki proxy listening on http://127.0.0.1:${port}`);
});
