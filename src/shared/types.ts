export type WikiLang = "zh" | "en";

export interface Citation {
  title: string;
  url: string;
  lang: WikiLang;
  /** Infobox portrait on the wiki. Absent when that page has no image yet. */
  image?: string;
}

export interface VisibleMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  preview: string;
}

export type ClientEvent =
  | { type: "session"; sessionId: string }
  | { type: "status"; text: string | null }
  | { type: "token"; text: string }
  | { type: "citations"; pages: Citation[] }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string };
