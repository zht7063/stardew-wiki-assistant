import { DurableObject } from "cloudflare:workers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createMockStreamFn } from "../agent/mock-llm";
import { createDeepSeekModel } from "../agent/model";
import { runChatTurn } from "../agent/run";
import { createWikiTools } from "../agent/tools";
import { visibleFromTranscript } from "../agent/visible";
import { citationFromUnknown } from "../shared/citations";
import type { Citation, ClientEvent, SessionSummary, VisibleMessage } from "../shared/types";
import { d1Executor } from "./d1-exec";
import { WikiIndex } from "../wiki/index-store";
import { vectorHitsFromBindings, withTimeout } from "../wiki/vectors";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ChatStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          preview TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          citations TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS transcripts (
          session_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS messages_session ON messages (session_id, id)`,
      );
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    try {
      if (request.method === "GET" && url.pathname === "/api/sessions") return this.list();
      if (request.method === "GET" && sessionMatch?.[1]) return this.read(sessionMatch[1]);
      if (request.method === "DELETE" && sessionMatch?.[1]) return this.remove(sessionMatch[1]);
      if (request.method === "POST" && url.pathname === "/api/chat") return await this.chat(request);
      return Response.json({ error: "没有这个接口" }, { status: 404 });
    } catch (error) {
      console.log(JSON.stringify({ level: "error", scope: "chat-store", message: error instanceof Error ? error.message : "unknown" }));
      return Response.json({ error: "服务器这边没接住，再试一次？" }, { status: 500 });
    }
  }

  private list(): Response {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; title: string; updated_at: number; preview: string }>(
        `SELECT id, title, updated_at, preview FROM sessions ORDER BY updated_at DESC LIMIT 40`,
      )
      .toArray();
    const sessions: SessionSummary[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
      preview: row.preview,
    }));
    return Response.json({ sessions });
  }

  private read(sessionId: string): Response {
    const session = this.ctx.storage.sql
      .exec<{ id: string; title: string; updated_at: number; preview: string }>(
        `SELECT id, title, updated_at, preview FROM sessions WHERE id = ?`,
        sessionId,
      )
      .toArray()[0];
    if (!session) return Response.json({ error: "找不到这轮对话" }, { status: 404 });
    const rows = this.ctx.storage.sql
      .exec<{ id: number; role: string; content: string; citations: string; created_at: number }>(
        `SELECT id, role, content, citations, created_at FROM messages WHERE session_id = ? ORDER BY id ASC`,
        sessionId,
      )
      .toArray();
    const messages: VisibleMessage[] = rows.map((row) => ({
      id: String(row.id),
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      citations: parseCitations(row.citations),
      createdAt: row.created_at,
    }));
    return Response.json({
      session: { id: session.id, title: session.title, updatedAt: session.updated_at, preview: session.preview },
      messages,
    });
  }

  private remove(sessionId: string): Response {
    this.ctx.storage.sql.exec(`DELETE FROM messages WHERE session_id = ?`, sessionId);
    this.ctx.storage.sql.exec(`DELETE FROM transcripts WHERE session_id = ?`, sessionId);
    this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE id = ?`, sessionId);
    return Response.json({ ok: true });
  }

  private async chat(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "没看懂这段请求" }, { status: 400 });
    }
    const message = isRecord(body) && typeof body.message === "string" ? body.message.trim() : "";
    const requestedId = isRecord(body) && typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!message) return Response.json({ error: "先写一点想问的吧" }, { status: 400 });
    if (message.length > 2000) return Response.json({ error: "这句话有点长，缩短到 2000 字以内吧" }, { status: 400 });

    const mock = this.env.MOCK_LLM === "1";
    if (!mock && !this.env.DEEPSEEK_API_KEY) {
      return Response.json(
        { error: "还没有配置 DeepSeek 密钥。部署时设置 DEEPSEEK_API_KEY，或者本地用 MOCK_LLM=1 预览。" },
        { status: 500 },
      );
    }

    const sessionId = requestedId || crypto.randomUUID();
    this.ensureSession(sessionId, message);
    const history = this.loadTranscript(sessionId);
    const abort = new AbortController();
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: ClientEvent) => {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        };
        try {
          send({ type: "session", sessionId });
          const wiki = new WikiIndex(d1Executor(this.env.WIKI_DB), (query) =>
            withTimeout(
              vectorHitsFromBindings(
                {
                  AI: {
                    run: (model, input) => this.env.AI.run(model, input),
                  },
                  WIKI_VECTORS: {
                    query: (vector, options) => this.env.WIKI_VECTORS.query(vector, options),
                  },
                },
                query,
              ),
              2500,
            ).then((hits) => hits ?? []),
          );
          const models = createModels();
          models.setProvider(deepseekProvider());
          const result = await runChatTurn({
            history,
            userText: message,
            model: createDeepSeekModel(this.env.DEEPSEEK_MODEL || "deepseek-flash"),
            streamFn: mock ? createMockStreamFn() : models.streamSimple.bind(models),
            tools: createWikiTools(wiki),
            apiKey: this.env.DEEPSEEK_API_KEY,
            signal: abort.signal,
            onEvent: send,
          });
          if (abort.signal.aborted) return;
          this.persist(sessionId, message, result.transcript);
          send({ type: "done", sessionId });
        } catch (error) {
          if (abort.signal.aborted) return;
          const text = error instanceof Error ? error.message : "没答上来";
          console.log(JSON.stringify({ level: "error", scope: "chat", message: text.slice(0, 300) }));
          send({ type: "error", message: friendlyError(text) });
        } finally {
          try {
            controller.close();
          } catch {
            // The client already went away.
          }
        }
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  private ensureSession(sessionId: string, firstMessage: string): void {
    const existing = this.ctx.storage.sql
      .exec<{ id: string }>(`SELECT id FROM sessions WHERE id = ?`, sessionId)
      .toArray()[0];
    if (existing) return;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO sessions (id, title, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      sessionId,
      titleFrom(firstMessage),
      "",
      now,
      now,
    );
  }

  private loadTranscript(sessionId: string): AgentMessage[] {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(`SELECT payload FROM transcripts WHERE session_id = ?`, sessionId)
      .toArray()[0];
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      return Array.isArray(parsed) ? (parsed as AgentMessage[]) : [];
    } catch {
      return [];
    }
  }

  private persist(sessionId: string, latestUserText: string, transcript: AgentMessage[]): void {
    const visible = visibleFromTranscript(transcript);
    const now = Date.now();
    const preview = [...visible].reverse().find((message) => message.content)?.content.slice(0, 48) ?? "";
    this.ctx.storage.sql.exec(`DELETE FROM messages WHERE session_id = ?`, sessionId);
    for (const message of visible) {
      this.ctx.storage.sql.exec(
        `INSERT INTO messages (session_id, role, content, citations, created_at) VALUES (?, ?, ?, ?, ?)`,
        sessionId,
        message.role,
        message.content,
        JSON.stringify(message.citations),
        now,
      );
    }
    this.ctx.storage.sql.exec(`DELETE FROM transcripts WHERE session_id = ?`, sessionId);
    this.ctx.storage.sql.exec(
      `INSERT INTO transcripts (session_id, payload) VALUES (?, ?)`,
      sessionId,
      JSON.stringify(transcript),
    );
    const title = titleFrom(latestUserText);
    this.ctx.storage.sql.exec(
      `UPDATE sessions SET updated_at = ?, preview = ?, title = CASE WHEN title = '新对话' THEN ? ELSE title END WHERE id = ?`,
      now,
      preview,
      title,
      sessionId,
    );
  }
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.slice(0, 18) || "新对话";
}

function parseCitations(raw: string): Citation[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((page) => {
      const citation = citationFromUnknown(page);
      return citation ? [citation] : [];
    });
  } catch {
    return [];
  }
}

function friendlyError(message: string): string {
  if (/api key|401|unauthorized/i.test(message)) return "DeepSeek 密钥好像不对，检查一下 Worker 里的 DEEPSEEK_API_KEY。";
  if (/aborted/i.test(message)) return "这次停住了。";
  if (message.length < 80 && /[\u4e00-\u9fff]/.test(message)) return message;
  return "翻 wiki 的时候卡住了，再问一次试试。";
}
