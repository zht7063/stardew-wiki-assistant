import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Citation } from "../shared/types";
import { WikiClient } from "../wiki/client";
import { formatMap, formatPage, formatSearch } from "../wiki/format";

const Lang = Type.Union([Type.Literal("zh"), Type.Literal("en")]);

const searchParameters = Type.Object({
  query: Type.String({ description: "页面名或很短的关键词，例如「阿比盖尔」或「草莓」" }),
  lang: Lang,
});

const pageParameters = Type.Object({
  title: Type.String({ description: "精确的页面标题，例如「阿比盖尔」" }),
  lang: Lang,
  section: Type.Optional(Type.String({ description: "可选章节名" })),
});

const mapParameters = Type.Object({
  title: Type.String({ description: "已知语言里的页面标题" }),
  from: Lang,
});

function textResult(text: string, pages: Citation[]) {
  return {
    content: [{ type: "text" as const, text }],
    details: { pages },
  };
}

export function createWikiTools(wiki: WikiClient): AgentTool[] {
  const searchWiki: AgentTool<typeof searchParameters> = {
    name: "search_wiki",
    label: "搜索 wiki",
    description:
      "在星露谷 wiki 搜索页面。query 用页面标题或 1～2 个关键词，不要用整句问话。lang 用 zh（优先）或 en。返回标题、链接和摘要。",
    parameters: searchParameters,
    execute: async (_toolCallId, params) => {
      const payload = await wiki.search(params.query, params.lang);
      // Search hits stay in the tool text for the model. Citation cards are
      // pages we actually opened, so a noisy search does not fill the thread.
      return textResult(formatSearch(payload), []);
    },
  };

  const getPage: AgentTool<typeof pageParameters> = {
    name: "get_page",
    label: "阅读页面",
    description:
      "读取一个 wiki 页面的信息卡和正文（表格会转成 markdown）。优先 lang=zh。中文没有时会自动改查英文。section 是章节名，例如「日程表」或「礼物」，省略则返回页面前部。",
    parameters: pageParameters,
    execute: async (_toolCallId, params) => {
      const page = await wiki.getPage(params.title, params.lang, params.section);
      const pages: Citation[] = [{ title: page.title, url: page.url, lang: page.lang }];
      if (page.counterpart) pages.push(page.counterpart);
      return textResult(formatPage(page), page.missing ? [] : pages);
    },
  };

  const mapTitle: AgentTool<typeof mapParameters> = {
    name: "map_title",
    label: "对照标题",
    description:
      "用 wiki 的 langlinks 把标题从中文换成英文，或从英文换成中文。from 是标题当前所在的语言。",
    parameters: mapParameters,
    execute: async (_toolCallId, params) => {
      const mapped = await wiki.mapTitle(params.title, params.from);
      const pages = [mapped.from, mapped.to].filter((page): page is Citation => Boolean(page));
      return textResult(formatMap(mapped), pages);
    },
  };

  return [searchWiki, getPage, mapTitle];
}
