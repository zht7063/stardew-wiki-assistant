import { createModels, type Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

/**
 * deepseek-chat was removed from the API on 2026-07-24.
 * deepseek-flash is the current chat model on the same OpenAI-compatible
 * endpoint (https://api.deepseek.com). The catalog entry supplies DeepSeek's
 * compat flags; thinking stays off so replies stay short on a phone.
 */
export function createDeepSeekModel(modelId = "deepseek-flash"): Model<"openai-completions"> {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const catalog =
    models.getModel("deepseek", "deepseek-v4-flash") ?? models.getModel("deepseek", modelId);
  if (!catalog || catalog.api !== "openai-completions") {
    throw new Error("DeepSeek model is missing from @earendil-works/pi-ai");
  }
  const deepseek = catalog as Model<"openai-completions">;
  return {
    ...deepseek,
    id: modelId,
    name: "DeepSeek Flash",
    maxTokens: 4096,
  };
}

export function stubModel(): Model<"openai-completions"> {
  return {
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1024,
  };
}
