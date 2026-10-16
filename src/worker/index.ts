import { randomResponse } from "../wiki/suggest";
import { requestAllowed } from "./auth";
import { ChatStore } from "./ChatStore";
import { d1Executor } from "./d1-exec";
import { proxyWikiImage } from "./image-proxy";

export { ChatStore };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, mock: env.MOCK_LLM === "1" });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await requestAllowed(request, env.APP_PASSWORD))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (request.method === "GET" && url.pathname === "/api/random") {
        try {
          return await randomResponse(d1Executor(env.WIKI_DB), url);
        } catch (error) {
          console.log(
            JSON.stringify({
              level: "error",
              scope: "random",
              message: error instanceof Error ? error.message : "unknown",
            }),
          );
          return Response.json({ suggestions: [] });
        }
      }
      if (request.method === "GET" && url.pathname === "/api/img") {
        return proxyWikiImage(request, env, ctx);
      }
      const stub = env.CHAT_STORE.get(env.CHAT_STORE.idFromName("owner"));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
