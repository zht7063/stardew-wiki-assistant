import { readEmbeddingMatrix } from "./embeddings";
import type { VectorHit } from "./index-store";
import type { WikiLang } from "../shared/types";

export const EMBED_MODEL = "@cf/baai/bge-m3";

export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function hitsFromMatches(matches: Array<{ score?: number; metadata?: Record<string, unknown> | null }>): VectorHit[] {
  const hits: VectorHit[] = [];
  for (const match of matches) {
    const lang = match.metadata?.lang;
    const title = match.metadata?.title;
    if ((lang !== "zh" && lang !== "en") || typeof title !== "string" || !title) continue;
    hits.push({ lang: lang as WikiLang, title, score: typeof match.score === "number" ? match.score : 0 });
  }
  return hits;
}

export async function vectorHitsFromBindings(
  env: {
    AI: { run: (model: string, input: { text: string[] }) => Promise<unknown> };
    WIKI_VECTORS: {
      query: (
        vector: number[],
        options: { topK: number; returnMetadata: "all" },
      ) => Promise<{ matches?: Array<{ score?: number; metadata?: Record<string, unknown> | null }> }>;
    };
  },
  query: string,
): Promise<VectorHit[]> {
  const text = query.trim().slice(0, 800);
  if (!text) return [];
  const matrix = await embedTexts((model, input) => env.AI.run(model, input), [text]);
  const vector = matrix[0];
  if (!vector || vector.length === 0) return [];
  const result = await env.WIKI_VECTORS.query(vector, { topK: 8, returnMetadata: "all" });
  return hitsFromMatches(result.matches ?? []);
}

export async function embedTexts(
  run: (model: string, input: { text: string[] }) => Promise<unknown>,
  texts: string[],
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const raw = await run(EMBED_MODEL, { text: texts.map((text) => text.slice(0, 1500)) });
  return readEmbeddingMatrix(raw);
}
