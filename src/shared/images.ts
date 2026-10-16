const WIKI_HOSTS = new Set(["zh.stardewvalleywiki.com", "stardewvalleywiki.com"]);

/** Absolute https URL of a file on one of the two Stardew wikis. */
export function wikiImageUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (!WIKI_HOSTS.has(url.hostname)) return null;
  if (!url.pathname.includes("/mediawiki/images/")) return null;
  if (url.pathname.includes("..")) return null;
  return url.toString();
}

export function wikiOrigin(lang: "zh" | "en"): string {
  return lang === "zh" ? "https://zh.stardewvalleywiki.com" : "https://stardewvalleywiki.com";
}
