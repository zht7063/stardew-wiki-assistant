import { wikiImageUrl } from "../shared/images";
import { USER_AGENT } from "../wiki/client";

const MAX_IMAGE_BYTES = 1_500_000;
const CACHE_SECONDS = 60 * 60 * 24 * 7;

export interface ImageCache {
  getWithMetadata<T>(key: string, type: "arrayBuffer"): Promise<{ value: ArrayBuffer | null; metadata: T | null }>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { expirationTtl?: number; metadata?: { contentType: string } },
  ): Promise<void>;
}

export interface Later {
  waitUntil(promise: Promise<unknown>): void;
}

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function edgeCache(): EdgeCache | null {
  const store = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return store?.default ?? null;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function imageContentType(header: string | null, imageUrl: string): string | null {
  const value = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (value.startsWith("image/")) return value;
  if (value && value !== "application/octet-stream" && value !== "binary/octet-stream") return null;
  const path = new URL(imageUrl).pathname.toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return null;
}

function imageResponse(body: ArrayBuffer | Uint8Array, contentType: string): Response {
  const payload = body instanceof Uint8Array ? body : new Uint8Array(body);
  return new Response(payload, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const advertised = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(advertised) && advertised > max) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch a wiki portrait for the phone when hotlinking is blocked.
 * Only `zh.stardewvalleywiki.com` and `stardewvalleywiki.com` image files are allowed.
 */
export async function proxyWikiImage(
  request: Request,
  env: { WIKI_CACHE: ImageCache },
  ctx: Later,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  if (request.method !== "GET") return new Response("只用 GET", { status: 405 });
  const target = wikiImageUrl(new URL(request.url).searchParams.get("u"));
  if (!target) return new Response("这张图不在 wiki 上", { status: 400 });

  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.search = `?u=${encodeURIComponent(target)}`;
  const cacheRequest = new Request(cacheKeyUrl.toString(), { method: "GET" });
  const edge = edgeCache();
  if (edge) {
    const hit = await edge.match(cacheRequest).catch(() => undefined);
    if (hit) return hit;
  }

  const kvKey = `img:v1:${await digest(target)}`;
  try {
    const stored = await env.WIKI_CACHE.getWithMetadata<{ contentType?: string }>(kvKey, "arrayBuffer");
    if (stored.value && stored.metadata?.contentType?.startsWith("image/")) {
      const response = imageResponse(stored.value, stored.metadata.contentType);
      if (edge) ctx.waitUntil(edge.put(cacheRequest, response.clone()).catch(() => undefined));
      return response;
    }
  } catch {
    // A missing or simulated KV binding should not hide the upstream attempt.
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "follow",
    });
  } catch {
    return new Response("没取到这张图", { status: 502 });
  }
  const finalUrl = wikiImageUrl(upstream.url || target);
  if (!upstream.ok || !finalUrl) return new Response("没取到这张图", { status: 502 });
  const bytes = await readCapped(upstream, MAX_IMAGE_BYTES);
  if (!bytes || bytes.byteLength === 0) return new Response("没取到这张图", { status: 502 });
  const contentType = imageContentType(upstream.headers.get("content-type"), finalUrl);
  if (!contentType) return new Response("这不是图片", { status: 502 });

  const response = imageResponse(bytes, contentType);
  ctx.waitUntil(
    env.WIKI_CACHE.put(kvKey, bytes, {
      expirationTtl: CACHE_SECONDS * 4,
      metadata: { contentType },
    }).catch(() => undefined),
  );
  if (edge) ctx.waitUntil(edge.put(cacheRequest, response.clone()).catch(() => undefined));
  return response;
}
