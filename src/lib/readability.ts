import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/**
 * Extracts the article body from HTML using Mozilla Readability.
 * Returns cleaned HTML on success, null if Readability couldn't parse it
 * (caller should fall back to the original content).
 *
 * Wraps bare article HTML in a minimal document — content:encoded is a
 * fragment, not a full page, so we give Readability enough structure to work.
 */
export function extractReadableContent(html: string): string | null {
  try {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const article = new Readability(document as any).parse();
    return article?.content ?? null;
  } catch {
    return null;
  }
}
