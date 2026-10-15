import { describe, expect, it } from "vitest";
import { createMockStreamFn } from "../src/agent/mock-llm";
import { stubModel } from "../src/agent/model";
import { runChatTurn } from "../src/agent/run";
import { createWikiTools } from "../src/agent/tools";
import { visibleFromTranscript } from "../src/agent/visible";
import type { ClientEvent } from "../src/shared/types";
import { WikiClient } from "../src/wiki/client";

const pageHtml = `
<div id="infoboxborder"><table id="infoboxtable">
<tr><td id="infoboxsection">居住于</td><td id="infoboxdetail">鹈鹕镇</td></tr>
<tr><td id="infoboxsection">最爱的礼物</td><td id="infoboxdetail">
<a href="/紫水晶">紫水晶</a> <a href="/南瓜">南瓜</a> <a href="/香蕉布丁">香蕉布丁</a>
</td></tr>
</table></div>
<p>阿比盖尔是可结婚的居民。</p>`;

function wiki() {
  return new WikiClient(async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("list") === "search") {
      const query = url.searchParams.get("srsearch") ?? "";
      if (query === "阿比盖尔") {
        return Response.json({ query: { search: [{ title: "阿比盖尔", snippet: "居民" }] } });
      }
      return Response.json({ query: { search: [] } });
    }
    if (url.searchParams.get("action") === "parse") {
      return Response.json({ parse: { title: "阿比盖尔", text: pageHtml, sections: [] } });
    }
    return Response.json({
      query: { pages: [{ title: "阿比盖尔", langlinks: [{ lang: "en", title: "Abigail" }] }] },
    });
  });
}

describe("agent loop", () => {
  it("searches, reads the page, and answers from the tool text", async () => {
    const events: ClientEvent[] = [];
    const result = await runChatTurn({
      history: [],
      userText: "阿比盖尔喜欢什么礼物？",
      model: stubModel(),
      streamFn: createMockStreamFn(),
      tools: createWikiTools(wiki()),
      onEvent: (event) => events.push(event),
    });

    const toolNames = result.transcript
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolName);
    expect(toolNames).toEqual(["search_wiki", "get_page"]);
    expect(result.assistantText).toContain("紫水晶");
    expect(result.assistantText).toContain("https://zh.stardewvalleywiki.com/");
    expect(result.assistantText).toContain("CC BY-NC-SA");
    expect(result.citations.some((page) => page.title === "阿比盖尔" && page.lang === "zh")).toBe(true);
    expect(events.some((event) => event.type === "status" && event.text?.includes("正在翻阅"))).toBe(true);
    expect(events.filter((event) => event.type === "token").map((event) => event.text).join("")).toContain("紫水晶");

    const visible = visibleFromTranscript(result.transcript);
    expect(visible.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(visible[1]?.citations[0]?.title).toBe("阿比盖尔");
  });

  it("uses earlier turns when the follow-up is short", async () => {
    const first = await runChatTurn({
      history: [],
      userText: "阿比盖尔喜欢什么礼物？",
      model: stubModel(),
      streamFn: createMockStreamFn(),
      tools: createWikiTools(wiki()),
    });
    const second = await runChatTurn({
      history: first.transcript,
      userText: "那她住在哪？",
      model: stubModel(),
      streamFn: createMockStreamFn(),
      tools: createWikiTools(wiki()),
    });
    const userMessages = second.transcript.filter((message) => message.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    expect(second.assistantText).toContain("鹈鹕镇");
    expect(second.assistantText).toContain("居住于");
  });
});
