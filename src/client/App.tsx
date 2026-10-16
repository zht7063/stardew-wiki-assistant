import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { dedupeCitations } from "../shared/citations";
import type { Citation, SessionSummary, VisibleMessage } from "../shared/types";
import {
  UnauthorizedError,
  deleteSession,
  listSessions,
  loadSession,
  savedSessionId,
  storePassword,
  storeSessionId,
  streamChat,
} from "./api";
import { Markdown } from "./markdown";

const STARTERS = [
  "阿比盖尔喜欢什么礼物？",
  "春天种什么最赚钱？",
  "社区中心的鱼缸要哪些鱼？",
  "怎么跟村民结婚？",
  "第一次下矿洞要准备什么？",
];

interface Bubble extends VisibleMessage {
  pending?: boolean;
}

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function mergeCitations(current: Citation[], incoming: Citation[]): Citation[] {
  return dedupeCitations([...current, ...incoming]);
}

function Mark({ className = "mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="40" cy="22" r="10" fill="#e7b85a" />
      <path d="M8 40c8-10 14-10 22 0 6 8 12 8 20-2 2 10 2 16-4 20H10c-4-4-4-12-2-18z" fill="#6d9a72" />
      <path d="M18 44h16l-2 8H16z" fill="#f7f1e6" />
      <path d="M16 44l10-12 10 12z" fill="#8a5a3b" />
      <circle cx="26" cy="48" r="1.6" fill="#c48a2a" />
    </svg>
  );
}

export function App() {
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      const overlap = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--kb", `${overlap}px`);
    };
    const pin = () => {
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
    };
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("scroll", pin);
    sync();
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("scroll", pin);
    };
  }, []);

  useEffect(() => {
    const id = savedSessionId();
    setSessionId(id);
    refreshSessions(id).catch((reason) => {
      if (reason instanceof UnauthorizedError) setLocked(true);
    });
  }, []);

  useEffect(() => {
    if (!stickRef.current) return;
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, status, busy]);

  async function refreshSessions(activeId = sessionId) {
    const next = await listSessions();
    setSessions(next);
    if (activeId && next.some((session) => session.id === activeId)) {
      const loaded = await loadSession(activeId);
      setMessages(loaded);
    }
  }

  function onScroll() {
    const node = threadRef.current;
    if (!node) return;
    stickRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }

  function resizeInput() {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }

  function openNewChat() {
    abortRef.current?.abort();
    setSessionId("");
    storeSessionId("");
    setMessages([]);
    setStatus(null);
    setError("");
    setDrawer(false);
    setDraft("");
  }

  async function openSession(id: string) {
    setDrawer(false);
    setError("");
    setSessionId(id);
    storeSessionId(id);
    try {
      setMessages(await loadSession(id));
    } catch (reason) {
      if (reason instanceof UnauthorizedError) setLocked(true);
      else setError(reason instanceof Error ? reason.message : "没打开这轮对话");
    }
  }

  async function removeSession(id: string) {
    try {
      await deleteSession(id);
      setSessions((current) => current.filter((session) => session.id !== id));
      if (sessionId === id) openNewChat();
    } catch (reason) {
      if (reason instanceof UnauthorizedError) setLocked(true);
      else setError(reason instanceof Error ? reason.message : "没删掉");
    }
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setError("");
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
    stickRef.current = true;
    const now = Date.now();
    const assistantId = `local-${now}`;
    setMessages((current) => [
      ...current,
      { id: `user-${now}`, role: "user", content: message, citations: [], createdAt: now },
      { id: assistantId, role: "assistant", content: "", citations: [], createdAt: now, pending: true },
    ]);
    setBusy(true);
    setStatus("正在想…");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        sessionId,
        message,
        (event) => {
          if (event.type === "session") {
            setSessionId(event.sessionId);
            storeSessionId(event.sessionId);
          } else if (event.type === "status") {
            setStatus(event.text);
          } else if (event.type === "token") {
            setMessages((current) =>
              current.map((bubble) =>
                bubble.id === assistantId ? { ...bubble, content: bubble.content + event.text } : bubble,
              ),
            );
          } else if (event.type === "citations") {
            setMessages((current) =>
              current.map((bubble) =>
                bubble.id === assistantId
                  ? { ...bubble, citations: mergeCitations(bubble.citations, event.pages) }
                  : bubble,
              ),
            );
          } else if (event.type === "error") {
            setError(event.message);
          }
        },
        controller.signal,
      );
      setStatus(null);
      setMessages((current) =>
        current.map((bubble) => (bubble.id === assistantId ? { ...bubble, pending: false } : bubble)),
      );
      const next = await listSessions();
      setSessions(next);
    } catch (reason) {
      if (reason instanceof UnauthorizedError) {
        setLocked(true);
        return;
      }
      if (controller.signal.aborted) {
        setStatus(null);
        setMessages((current) =>
          current.flatMap((bubble) => {
            if (bubble.id !== assistantId) return [bubble];
            if (!bubble.content) return [];
            return [{ ...bubble, pending: false }];
          }),
        );
        return;
      }
      setStatus(null);
      setError(reason instanceof Error ? reason.message : "没送出去");
      setMessages((current) => current.filter((bubble) => bubble.id !== assistantId || bubble.content));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function unlock(event: FormEvent) {
    event.preventDefault();
    storePassword(password.trim());
    setLocked(false);
    setError("");
    refreshSessions(savedSessionId()).catch((reason) => {
      if (reason instanceof UnauthorizedError) setLocked(true);
      else setError(reason instanceof Error ? reason.message : "没打开");
    });
  }

  const empty = messages.length === 0;
  const showStatus = Boolean(status) && (busy || messages.some((message) => message.pending));
  const title = useMemo(() => {
    const current = sessions.find((session) => session.id === sessionId);
    return current?.title || "星露问答";
  }, [sessions, sessionId]);

  if (locked) {
    return (
      <main className="lock-screen">
        <Mark className="mark mark-lg" />
        <h1>这本笔记上了锁</h1>
        <p>输入家里约定的口令，才能继续问。</p>
        <form onSubmit={unlock}>
          <input
            id="app-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            placeholder="口令"
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit">打开</button>
        </form>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-button" type="button" aria-label="最近的对话" onClick={() => setDrawer(true)}>
          <MenuIcon />
        </button>
        <div className="brand">
          <Mark />
          <div className="brand-text">
            <h1>{empty ? "星露问答" : title}</h1>
            <p>翻一翻 wiki 再回答</p>
          </div>
        </div>
        <button className="icon-button" type="button" aria-label="新对话" onClick={openNewChat}>
          <ComposeIcon />
        </button>
      </header>

      <div className="thread" ref={threadRef} onScroll={onScroll}>
        {empty ? (
          <section className="empty">
            <div className="meadow" aria-hidden="true">
              <Mark className="mark mark-lg" />
            </div>
            <h2>今天想问点什么？</h2>
            <p>礼物、鱼、作物、村民的日程，我先去 wiki 上核对，再告诉你。</p>
            <div className="chips">
              {STARTERS.map((question) => (
                <button key={question} type="button" className="chip" onClick={() => send(question)}>
                  {question}
                </button>
              ))}
            </div>
            <p className="fine">内容来自星露谷维基，CC BY-NC-SA。和 ConcernedApe 没有官方关系。</p>
          </section>
        ) : (
          <ol className="messages">
            {messages.map((message) => (
              <li key={message.id} className={`bubble ${message.role}`}>
                {message.role === "assistant" ? (
                  message.content ? (
                    <Markdown text={message.content} />
                  ) : (
                    <p className="thinking">{status || "正在想…"}</p>
                  )
                ) : (
                  <p>{message.content}</p>
                )}
                {message.role === "assistant" && message.pending && message.content && showStatus ? (
                  <p className="thinking">{status}</p>
                ) : null}
                {message.citations.length > 0 ? (
                  <div className="citations">
                    {message.citations.map((page) => (
                      <a key={page.url} className="cite" href={page.url} target="_blank" rel="noopener noreferrer">
                        <span>{page.lang === "zh" ? "中文 wiki" : "英文 wiki"}</span>
                        <strong>{page.title}</strong>
                        <em>{page.lang === "zh" ? "zh.stardewvalleywiki.com" : "stardewvalleywiki.com"}</em>
                      </a>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      {error ? <p className="error">{error}</p> : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          id="chat-input"
          name="message"
          ref={inputRef}
          rows={1}
          value={draft}
          aria-label="问题"
          placeholder="问问星露谷的事…"
          enterKeyHint="send"
          onChange={(event) => {
            setDraft(event.target.value);
            resizeInput();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
        />
        {busy ? (
          <button className="send stop" type="button" aria-label="停止" onClick={() => abortRef.current?.abort()}>
            <span />
          </button>
        ) : (
          <button className="send" type="submit" aria-label="发送" disabled={!draft.trim()}>
            <SendIcon />
          </button>
        )}
      </form>

      {drawer ? (
        <div className="drawer-root">
          <button className="scrim" type="button" aria-label="关闭列表" onClick={() => setDrawer(false)} />
          <aside className="drawer">
            <div className="drawer-head">
              <h2>最近的对话</h2>
              <button type="button" onClick={openNewChat}>
                新对话
              </button>
            </div>
            {sessions.length === 0 ? <p className="muted">还没有问过。从下面选一个问题开始吧。</p> : null}
            <ul>
              {sessions.map((session) => (
                <li key={session.id}>
                  <button type="button" className="session" onClick={() => openSession(session.id)}>
                    <strong>{session.title}</strong>
                    <span>{session.preview || "还没有回答"}</span>
                    <em>{relativeTime(session.updatedAt)}</em>
                  </button>
                  <button
                    type="button"
                    className="trash"
                    aria-label={`删除${session.title}`}
                    onClick={() => {
                      if (window.confirm(`删掉「${session.title}」？`)) void removeSession(session.id);
                    }}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ComposeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h12M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
