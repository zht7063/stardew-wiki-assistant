import { requestAllowed } from "./auth";
import { ChatStore } from "./ChatStore";

export { ChatStore };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, mock: env.MOCK_LLM === "1" });
    }
    if (url.pathname.startsWith("/api/")) {
      if (!(await requestAllowed(request, env.APP_PASSWORD))) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const stub = env.CHAT_STORE.get(env.CHAT_STORE.idFromName("owner"));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
