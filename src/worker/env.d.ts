interface Env {
  DEEPSEEK_API_KEY?: string;
  APP_PASSWORD?: string;
  MOCK_LLM?: string;
  /** Local only. Node HTTP/2 proxy, because wrangler dev fetch is HTTP/1.1. */
  WIKI_PROXY?: string;
}
