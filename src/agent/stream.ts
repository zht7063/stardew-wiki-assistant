import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

function cloneMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block) => ({ ...block })),
    usage: {
      ...message.usage,
      cost: { ...message.usage.cost },
    },
  };
}

export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Push a finished assistant message as start / delta / done events. */
export function streamAssistantMessage(
  message: AssistantMessage,
  chunkSize = 12,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const partial = cloneMessage({ ...message, content: [], stopReason: "pending" });
  stream.push({ type: "start", partial: cloneMessage(partial) });
  message.content.forEach((block, contentIndex) => {
    if (block.type === "text") {
      partial.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial: cloneMessage(partial) });
      let accumulated = "";
      for (let index = 0; index < block.text.length; index += chunkSize) {
        const delta = block.text.slice(index, index + chunkSize);
        accumulated += delta;
        partial.content[contentIndex] = { type: "text", text: accumulated };
        stream.push({
          type: "text_delta",
          contentIndex,
          delta,
          partial: cloneMessage(partial),
        });
      }
      stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: cloneMessage(partial),
      });
      return;
    }
    if (block.type === "toolCall") {
      partial.content.push({ ...block });
      stream.push({ type: "toolcall_start", contentIndex, partial: cloneMessage(partial) });
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial: cloneMessage(partial),
      });
    }
  });
  const reason = message.stopReason === "toolUse" || message.stopReason === "length" ? message.stopReason : "stop";
  stream.push({ type: "done", reason, message });
  return stream;
}
