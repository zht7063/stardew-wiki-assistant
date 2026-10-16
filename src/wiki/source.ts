import type { WikiLang } from "../shared/types";
import type { MapPayload, PagePayload, SearchPayload } from "./client";

/** What the chat tools call. The Worker implements this on the offline index. */
export interface WikiSource {
  search(query: string, lang: WikiLang): Promise<SearchPayload>;
  getPage(title: string, lang: WikiLang, section?: string): Promise<PagePayload>;
  mapTitle(title: string, from: WikiLang): Promise<MapPayload>;
}
