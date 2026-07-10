export interface ExtractionOptions {
  offset: number;
  maxCharacters: number;
  includeLinks: boolean;
}

// Must stay self-contained: Chrome serializes only this function when executeScript uses `func`.
export function extractPage(options: ExtractionOptions) {
  const normalizeText = (value: string): string =>
    value
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

  const sensitiveQueryKey = /(?:access[_-]?token|token|auth|authorization|api[_-]?key|secret|session|code|sig|signature|jwt|credential|password)/i;
  const sanitizeUrl = (rawUrl: string): string => {
    try {
      const url = new URL(rawUrl);
      url.username = "";
      url.password = "";
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (sensitiveQueryKey.test(key)) url.searchParams.set(key, "[REDACTED]");
      }
      return url.toString();
    } catch {
      return "";
    }
  };

  const isVisible = (element: Element): boolean => {
    const htmlElement = element as HTMLElement;
    const style = globalThis.getComputedStyle(htmlElement);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = htmlElement.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  const root = document.querySelector("main, article, [role='main']") ?? document.body;
  const rawText = normalizeText((root as HTMLElement | null)?.innerText ?? "");
  const offset = Math.min(options.offset, rawText.length);
  const text = rawText.slice(offset, offset + options.maxCharacters);

  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .filter(isVisible)
    .map((element) => ({
      level: Number.parseInt(element.tagName.slice(1), 10),
      text: normalizeText((element as HTMLElement).innerText),
    }))
    .filter((heading) => heading.text.length > 0)
    .slice(0, 100);

  const links = options.includeLinks
    ? Array.from(document.querySelectorAll("a[href]"))
        .filter(isVisible)
        .map((element) => {
          const anchor = element as HTMLAnchorElement;
          return { text: normalizeText(anchor.innerText || anchor.getAttribute("aria-label") || ""), href: sanitizeUrl(anchor.href) };
        })
        .filter((link) => link.text.length > 0 && /^https?:/i.test(link.href))
        .slice(0, 100)
    : [];

  const description =
    document.querySelector<HTMLMetaElement>('meta[name="description"], meta[property="og:description"]')?.content ?? "";

  return {
    title: document.title,
    url: sanitizeUrl(location.href),
    language: document.documentElement.lang || navigator.language || "",
    description: normalizeText(description),
    headings,
    links,
    text,
    offset,
    returnedCharacters: text.length,
    totalCharacters: rawText.length,
    truncated: offset + text.length < rawText.length,
  };
}
