import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { citationFromUnknown, dedupeCitations } from "../shared/citations";
import type { Citation, ClientEvent } from "../shared/types";
import { SYSTEM_PROMPT } from "./prompt";

export interface RunChatInput {
  history: AgentMessage[];
  userText: string;
  model: Model<"openai-completions">;
  streamFn: StreamFn;
  tools: AgentTool[];
  apiKey?: string;
  signal?: AbortSignal;
  onEvent?: (event: ClientEvent) => void;
}

export interface RunChatResult {
  transcript: AgentMessage[];
  assistantText: string;
  citations: Citation[];
}

const MAX_TURNS = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pagesFromDetails(details: unknown): Citation[] {
  if (!isRecord(details) || !Array.isArray(details.pages)) return [];
  return details.pages.flatMap((page) => {
    const citation = citationFromUnknown(page);
    return citation ? [citation] : [];
  });
}

function statusText(toolName: string, args: unknown): string {
  const record = isRecord(args) ? args : {};
  const subject = typeof record.query === "string" ? record.query : typeof record.title === "string" ? record.title : "";
  if (toolName === "map_title") return subject ? `正在对照「${subject}」的中英文标题…` : "正在对照中英文标题…";
  return subject ? `正在翻阅「${subject}」…` : "正在翻阅 wiki…";
}

/** Keep tool-call groups intact and start the window on a user message. */
export function trimHistory(messages: AgentMessage[], max = 24): AgentMessage[] {
  if (messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start]?.role !== "user") start += 1;
  if (start >= messages.length) return messages.slice(-max);
  return messages.slice(start);
}

function assistantText(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content.filter((block) => block.type === "text").map((block) => block.text))
    .join("\n")
    .trim();
}

export async function runChatTurn(input: RunChatInput): Promise<RunChatResult> {
  const citations: Citation[] = [];
  let turns = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: input.model,
      thinkingLevel: "off",
      tools: input.tools,
      messages: input.history,
    },
    streamFn: input.streamFn,
    getApiKey: input.apiKey ? async () => input.apiKey : undefined,
    toolExecution: "sequential",
    transformContext: async (messages) => trimHistory(messages),
    shouldStopAfterTurn: () => {
      turns += 1;
      return turns >= MAX_TURNS;
    },
  });
  if (input.signal) {
    if (input.signal.aborted) agent.abort();
    else input.signal.addEventListener("abort", () => agent.abort(), { once: true });
  }
  agent.subscribe((event) => {
    const emit = input.onEvent;
    if (!emit) return;
    if (event.type === "turn_start") emit({ type: "status", text: "正在想…" });
    if (event.type === "tool_execution_start") {
      emit({ type: "status", text: statusText(event.toolName, event.args) });
    }
    if (event.type === "tool_execution_end") {
      const next = dedupeCitations([...citations, ...pagesFromDetails(event.result?.details)]);
      if (next.length === citations.length) return;
      citations.splice(0, citations.length, ...next);
      emit({ type: "citations", pages: citations });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      emit({ type: "token", text: event.assistantMessageEvent.delta });
      emit({ type: "status", text: null });
    }
  });
  await agent.prompt(input.userText);
  const transcript = agent.state.messages.slice();
  const last = transcript[transcript.length - 1];
  if (last?.role === "assistant" && last.stopReason === "error") {
    throw new Error(last.errorMessage || "模型没有答上来");
  }
  return {
    transcript,
    assistantText: assistantText(transcript.slice(input.history.length)),
    citations,
  };
}
