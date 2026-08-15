import { parseHTML } from "linkedom";

// Lenient feed parser for malformed XML/HTML feeds.
// Uses linkedom (an HTML parser, far more tolerant than xml2js used by
// rss-parser) to extract feed items when the primary parser fails.
// Handles both RSS 2.0 and Atom 1.0 formats.

export interface FallbackFeedItem {
  guid: string | null;
  title: string | null;
  link: string | null;
  content: string | null;
  contentEncoded: string | null;
  summary: string | null;
  contentSnippet: string | null;
  creator: string | null;
  author: string | null;
  isoDate: string | null;
}

export interface FallbackFeed {
  title: string | null;
  link: string | null;
  ttl: string | null;
  items: FallbackFeedItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(parent: Element, selector: string): string | null {
  const el = parent.querySelector(selector);
  return el?.textContent?.trim() ?? null;
}

function textByName(parent: Element, localName: string): string | null {
  const lower = localName.toLowerCase();
  for (const child of parent.children) {
    if (child.localName.toLowerCase() === lower) {
      return child.textContent?.trim() ?? null;
    }
  }
  // Also check deeply nested (e.g. Atom author/name)
  for (const child of parent.children) {
    const found = child.querySelector(localName);
    if (found) return found.textContent?.trim() ?? null;
  }
  return null;
}

function attr(
  parent: Element,
  selector: string,
  attrName: string,
): string | null {
  const el = parent.querySelector(selector);
  return el?.getAttribute(attrName)?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// RSS 2.0 extraction
// ---------------------------------------------------------------------------

function parseRssItems(root: Element): FallbackFeedItem[] {
  const items: FallbackFeedItem[] = [];
  const itemEls = root.querySelectorAll("channel > item, item");
  for (const el of itemEls) {
    const contentEncoded = textByName(el, "content:encoded");
    const description = text(el, "description");
    const content = contentEncoded ?? description;
    items.push({
      guid: text(el, "guid") ?? text(el, "link"),
      title: text(el, "title"),
      link: text(el, "link"),
      content,
      contentEncoded,
      summary: description,
      contentSnippet: description ? stripHtml(description) : null,
      creator: textByName(el, "dc:creator") ?? text(el, "author"),
      author: text(el, "author"),
      isoDate: text(el, "pubDate"),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Atom 1.0 extraction
// ---------------------------------------------------------------------------

function parseAtomEntries(root: Element): FallbackFeedItem[] {
  const entries: FallbackFeedItem[] = [];
  const entryEls = root.querySelectorAll("feed > entry, entry");
  for (const el of entryEls) {
    const content = text(el, "content");
    const summary = text(el, "summary");
    entries.push({
      guid: text(el, "id"),
      title: text(el, "title"),
      link:
        attr(el, 'link[rel="alternate"]', "href") ?? attr(el, "link", "href"),
      content,
      contentEncoded: content,
      summary,
      contentSnippet: summary
        ? stripHtml(summary)
        : content
          ? stripHtml(content)
          : null,
      creator: text(el, "author > name") ?? text(el, "author > email"),
      author: text(el, "author > name") ?? text(el, "author > email"),
      isoDate: text(el, "published") ?? text(el, "updated"),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseFeedLenient(xml: string): FallbackFeed | null {
  try {
    const { document } = parseHTML(`<html><body>${xml}</body></html>`);
    const body = document.body;

    // Detect format: RSS has <channel>, Atom has <feed>
    const hasRss = body.querySelector("rss, channel, item");
    const hasAtom = body.querySelector("feed, entry");

    let items: FallbackFeedItem[];
    if (hasRss && !hasAtom) {
      items = parseRssItems(body);
    } else if (hasAtom && !hasRss) {
      items = parseAtomEntries(body);
    } else if (hasRss && hasAtom) {
      // Ambiguous — prefer the one with more items
      const rssItems = parseRssItems(body);
      const atomEntries = parseAtomEntries(body);
      items = rssItems.length >= atomEntries.length ? rssItems : atomEntries;
    } else {
      return null;
    }

    if (items.length === 0) return null;

    const title =
      text(body, "channel > title") ?? text(body, "feed > title") ?? null;
    const link =
      text(body, "channel > link") ??
      attr(body, 'feed > link[rel="alternate"]', "href") ??
      attr(body, "feed > link", "href") ??
      null;
    const ttl = text(body, "channel > ttl") ?? null;

    return { title, link, ttl, items };
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  try {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    return document.body.textContent?.trim() ?? "";
  } catch {
    return html.replace(/<[^>]*>/g, "").trim();
  }
}
