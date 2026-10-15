import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWikiHtml, queryCandidates } from "../src/wiki/parse";

const html = readFileSync(new URL("./fixtures/abigail.html", import.meta.url), "utf8");

describe("wiki html parsing", () => {
  it("keeps infobox fields and drops image filenames", () => {
    const page = parseWikiHtml(html);
    const birthday = page.infobox.find((field) => field.label === "生日");
    const gifts = page.infobox.find((field) => field.label === "最爱的礼物");
    expect(birthday?.value).toContain("秋季");
    expect(birthday?.value).toContain("13日");
    expect(gifts?.value).toBe("紫水晶、香蕉布丁、南瓜");
    expect(gifts?.value).not.toContain("Amethyst");
    expect(page.infobox.some((field) => field.label === "信息")).toBe(false);
  });

  it("renders the intro and a readable table, without nav or edit chrome", () => {
    const page = parseWikiHtml(html);
    expect(page.markdown).toContain("结婚");
    expect(page.markdown).toContain("| 时间 | 地点 |");
    expect(page.markdown).toContain("| 09:00 | 位于她的卧室。 |");
    expect(page.markdown).toContain("哈维的诊所");
    expect(page.markdown).not.toContain("导航不该出现");
    expect(page.markdown).not.toContain("编辑");
    expect(page.sections).toEqual(["日程表", "礼物"]);
  });

  it("returns one section when asked", () => {
    const page = parseWikiHtml(html, { section: "日程表" });
    expect(page.markdown).toContain("09:00");
    expect(page.markdown).toContain("下雨时她会待在家里");
    expect(page.markdown).not.toContain("她最喜欢紫水晶");
  });
});

describe("search keywords", () => {
  it("shortens a spoken Chinese question to a page title", () => {
    expect(queryCandidates("阿比盖尔喜欢什么礼物？")).toEqual([
      "阿比盖尔喜欢什么礼物？",
      "阿比盖尔喜欢礼物",
      "阿比盖尔",
    ]);
  });
});
