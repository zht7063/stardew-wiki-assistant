import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { queryCandidates } from "../wiki/parse";
import { emptyUsage, streamAssistantMessage } from "./stream";

function messageText(message: AgentMessage | undefined): string {
  if (!message) return "";
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
  if (message.role === "toolResult" || message.role === "assistant") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  }
  return "";
}

function baseMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { type: "toolCall", id: `mock_${name}_${Math.random().toString(36).slice(2, 8)}`, name, arguments: args };
}

function firstTitle(searchText: string): string | undefined {
  const match = searchText.match(/^\d+\.\s+(.+)$/m);
  const title = match?.[1]?.trim();
  return title || undefined;
}

function infoboxRows(pageText: string): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  let inCard = false;
  for (const line of pageText.split("\n")) {
    if (line.startsWith("## 信息卡")) {
      inCard = true;
      continue;
    }
    if (inCard && line.startsWith("## ")) break;
    if (inCard && line.startsWith("# ")) break;
    const field = line.match(/^- ([^:]+):\s*(.+)$/);
    if (inCard && field?.[1] && field[2]) rows.push([field[1].trim(), field[2].trim()]);
  }
  return rows;
}

function pickRows(rows: Array<[string, string]>, question: string): Array<[string, string]> {
  const focused = rows.filter(([label]) => {
    if (/礼物/.test(question) && /礼物|最爱|喜欢/.test(label)) return true;
    if (/住|家|地址/.test(question) && /居住|地址|家庭/.test(label)) return true;
    if (/生日/.test(question) && /生日/.test(label)) return true;
    if (/结婚/.test(question) && /结婚/.test(label)) return true;
    return false;
  });
  if (focused.length === 0) return rows.slice(0, 6);
  const rest = rows.filter((row) => !focused.includes(row));
  return [...focused, ...rest].slice(0, 6);
}

function composeAnswer(pageText: string, question: string): string {
  const title = pageText.match(/^#\s+(.+)$/m)?.[1]?.trim() || "这一页";
  const url = pageText.match(/链接:\s*(\S+)/)?.[1] ?? "";
  const note = pageText.includes("英文 wiki") ? "中文页没覆盖到的地方，我补了一眼英文 wiki。" : "";
  const fields = pickRows(infoboxRows(pageText), question);
  const lead = fields[0] ? `${fields[0][0]}：${fields[0][1]}` : "";
  const table =
    fields.length > 0
      ? ["| 项目 | 内容 |", "| --- | --- |", ...fields.map(([label, value]) => `| ${label} | ${value} |`)].join("\n")
      : "";
  const prose = pageText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("-") && !line.startsWith("|") && !line.startsWith("链接") && !line.startsWith("语言") && !line.startsWith("章节") && !line.startsWith("对照") && line.length > 12);
  const lines = [`我翻了 wiki，关于「${title}」值得先记住这些：`, lead, note, table, prose ? prose : "", url ? `详细看：[${title}](${url})` : "", "资料来自星露谷维基（Stardew Valley Wiki），采用 CC BY-NC-SA 许可。"];
  return lines.filter(Boolean).join("\n\n");
}

/**
 * Scripted stand-in for DeepSeek. It still runs the real tool loop:
 * search, open the best page, then answer from that page's text.
 */
export function createMockStreamFn(): StreamFn {
  return (model, context) => {
    const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
    const question = messageText(lastUser);
    let lastUserIndex = -1;
    for (let index = context.messages.length - 1; index >= 0; index -= 1) {
      if (context.messages[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const candidates = queryCandidates(question);
    let keyword = candidates[candidates.length - 1] || question.slice(0, 12) || "星露谷";
    let earlierTitle = "";
    for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
      const message = context.messages[index];
      if (message?.role !== "toolResult" || message.toolName !== "get_page") continue;
      earlierTitle = messageText(message).match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
      if (earlierTitle) break;
    }
    if (earlierTitle && /她|他|它|这|那|上面|刚才/.test(question)) keyword = earlierTitle;
    const toolMessages = context.messages
      .slice(lastUserIndex + 1)
      .filter((message) => message.role === "toolResult");
    const called = new Set(toolMessages.map((message) => message.toolName));
    if (!called.has("search_wiki")) {
      const call = toolCall("search_wiki", { query: keyword, lang: "zh" });
      return streamAssistantMessage(baseMessage(model, [call], "toolUse"));
    }
    if (!called.has("get_page")) {
      const searchText = toolMessages
        .filter((message) => message.toolName === "search_wiki")
        .map((message) => messageText(message))
        .join("\n");
      const title = firstTitle(searchText) || keyword;
      const call = toolCall("get_page", { title, lang: "zh" });
      return streamAssistantMessage(baseMessage(model, [call], "toolUse"));
    }
    const pageText = toolMessages
      .filter((message) => message.toolName === "get_page")
      .map((message) => messageText(message))
      .join("\n");
    const answer = pageText.includes("没有找到")
      ? `我在中文和英文 wiki 里都没找到和「${keyword}」对应的页面。换个更具体的名字，比如一个村民或一种作物，我再帮你翻。\n\n资料来自星露谷维基（Stardew Valley Wiki），采用 CC BY-NC-SA 许可。`
      : composeAnswer(pageText, question);
    return streamAssistantMessage(baseMessage(model, [{ type: "text", text: answer }], "stop"), 8);
  };
}
