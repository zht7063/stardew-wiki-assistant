import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { dedupeCitations } from "../shared/citations";
import type { Citation } from "../shared/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function pagesFromDetails(details: unknown): Citation[] {
  if (!isRecord(details) || !Array.isArray(details.pages)) return [];
  return details.pages.flatMap((page) => {
    if (!isRecord(page)) return [];
    if (typeof page.title !== "string" || typeof page.url !== "string") return [];
    if (page.lang !== "zh" && page.lang !== "en") return [];
    return [{ title: page.title, url: page.url, lang: page.lang }];
  });
}

export function visibleFromTranscript(
  transcript: AgentMessage[],
): Array<{ role: "user" | "assistant"; content: string; citations: Citation[] }> {
  const visible: Array<{ role: "user" | "assistant"; content: string; citations: Citation[] }> = [];
  let pending: Citation[] = [];
  for (const message of transcript) {
    if (message.role === "toolResult") {
      pending = dedupeCitations([...pending, ...pagesFromDetails(message.details)]);
      continue;
    }
    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? message.content.trim()
          : message.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("")
              .trim();
      if (content) visible.push({ role: "user", content, citations: [] });
      continue;
    }
    if (message.role === "assistant") {
      const content = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
      const hasTools = message.content.some((block) => block.type === "toolCall");
      if (!content) continue;
      visible.push({ role: "assistant", content, citations: hasTools ? [] : dedupeCitations(pending) });
      if (!hasTools) pending = [];
    }
  }
  return visible;
}
