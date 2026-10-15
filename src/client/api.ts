import type { ClientEvent, SessionSummary, VisibleMessage } from "../shared/types";

const PASS_KEY = "stardew-pass";
const SESSION_KEY = "stardew-session";

export function savedPassword(): string {
  return localStorage.getItem(PASS_KEY) ?? "";
}

export function storePassword(password: string): void {
  if (password) localStorage.setItem(PASS_KEY, password);
  else localStorage.removeItem(PASS_KEY);
}

export function savedSessionId(): string {
  return localStorage.getItem(SESSION_KEY) ?? "";
}

export function storeSessionId(id: string): void {
  if (id) localStorage.setItem(SESSION_KEY, id);
  else localStorage.removeItem(SESSION_KEY);
}

function headers(json = false): Headers {
  const result = new Headers();
  if (json) result.set("Content-Type", "application/json");
  const password = savedPassword();
  if (password) result.set("Authorization", `Bearer ${password}`);
  return result;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) throw new UnauthorizedError();
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求没成功");
  return data;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const response = await fetch("/api/sessions", { headers: headers() });
  const data = await readJson<{ sessions: SessionSummary[] }>(response);
  return data.sessions;
}

export async function loadSession(id: string): Promise<VisibleMessage[]> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { headers: headers() });
  const data = await readJson<{ messages: VisibleMessage[] }>(response);
  return data.messages;
}

export async function deleteSession(id: string): Promise<void> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(),
  });
  await readJson(response);
}

export async function streamChat(
  sessionId: string,
  message: string,
  onEvent: (event: ClientEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ sessionId: sessionId || undefined, message }),
    signal,
  });
  if (response.status === 401) throw new UnauthorizedError();
  if (!response.ok || !response.body) {
    let messageText = "请求没成功";
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) messageText = data.error;
    } catch {
      // The body was not JSON.
    }
    throw new Error(messageText);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      if (!chunk.trim() || chunk.startsWith(":")) continue;
      let eventName = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data) as ClientEvent;
      if (parsed.type === eventName || parsed.type) onEvent(parsed);
    }
  }
}
