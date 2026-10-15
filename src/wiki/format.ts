import type { PagePayload, SearchPayload } from "./client";
import type { MapPayload } from "./client";

export function formatSearch(payload: SearchPayload): string {
  const lines = [`搜索「${payload.query}」（${payload.lang}）`];
  if (payload.note) lines.push(payload.note);
  if (payload.results.length === 0) {
    lines.push("没有结果。");
    return lines.join("\n");
  }
  payload.results.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title}`);
    lines.push(`   ${hit.url}`);
    if (hit.snippet) lines.push(`   ${hit.snippet}`);
  });
  lines.push("下一步：对最相关的标题调用 get_page。");
  return lines.join("\n");
}

export function formatPage(page: PagePayload): string {
  if (page.missing) {
    return [`没有找到「${page.title}」（${page.lang}）。`, page.note ?? "", page.markdown]
      .filter(Boolean)
      .join("\n");
  }
  const lines = [`# ${page.title}`, `链接: ${page.url}`, `语言: ${page.lang}`];
  if (page.counterpart) {
    lines.push(`对照页面（${page.counterpart.lang}）: ${page.counterpart.title} ${page.counterpart.url}`);
  }
  if (page.note) lines.push(page.note);
  if (page.infobox.length > 0) {
    lines.push("", "## 信息卡");
    for (const field of page.infobox) lines.push(`- ${field.label}: ${field.value}`);
  }
  if (page.markdown) lines.push("", page.markdown);
  if (page.sections.length > 0) {
    lines.push("", `章节: ${page.sections.slice(0, 24).join("、")}`);
  }
  return lines.join("\n").trim();
}

export function formatMap(payload: MapPayload): string {
  if (!payload.to) {
    return `「${payload.from.title}」（${payload.from.lang}）没有${payload.from.lang === "zh" ? "英文" : "中文"}对照页。${payload.note ?? ""}`.trim();
  }
  return [
    `${payload.from.lang}: ${payload.from.title}`,
    payload.from.url,
    `${payload.to.lang}: ${payload.to.title}`,
    payload.to.url,
  ].join("\n");
}
