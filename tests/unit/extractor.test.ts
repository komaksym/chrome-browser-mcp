// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { extractPage } from "../../src/extension/extractor.js";

function makeVisible(element: Element, innerText: string): void {
  Object.defineProperty(element, "innerText", { configurable: true, value: innerText });
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} }),
  });
}

describe("extractPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    document.head.innerHTML = '<title>Test page</title><meta name="description" content="A test">';
    document.body.innerHTML = `
      <main><h1>Heading</h1><p>Visible body text</p><a href="https://user:pass@example.com/path?token=super-secret&view=1#private">Example</a></main>
      <input type="password" value="super-secret">
    `;
    const main = document.querySelector("main")!;
    const heading = document.querySelector("h1")!;
    const link = document.querySelector("a")!;
    makeVisible(main, "Heading\nVisible body text\nExample");
    makeVisible(heading, "Heading");
    makeVisible(link, "Example");
  });

  it("returns visible semantic content and never reads input values", () => {
    const result = extractPage({ offset: 0, maxCharacters: 1_000, includeLinks: true });
    expect(result.title).toBe("Test page");
    expect(result.text).toContain("Visible body text");
    expect(result.text).not.toContain("super-secret");
    expect(result.headings).toEqual([{ level: 1, text: "Heading" }]);
    expect(result.links).toEqual([{ text: "Example", href: "https://example.com/path?token=%5BREDACTED%5D&view=1" }]);
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("supports deterministic pagination", () => {
    const first = extractPage({ offset: 0, maxCharacters: 7, includeLinks: false });
    const second = extractPage({ offset: 7, maxCharacters: 100, includeLinks: false });
    expect(first.text + second.text).toBe("Heading\nVisible body text\nExample");
    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(false);
  });
});
