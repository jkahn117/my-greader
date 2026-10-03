import { parseHTML } from "linkedom";

// linkedom's declarations refer to the browser Element type, while Workers
// intentionally supplies a smaller global Element declaration. Keep the DOM
// operations used by this parser local instead of adding the browser DOM lib.
interface FeedNode {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly nextSibling: FeedNode | null;
}

interface FeedElement extends FeedNode {
  readonly childNodes: Iterable<FeedNode>;
  readonly children: Iterable<FeedElement>;
  readonly localName: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): FeedElement | null;
  querySelectorAll(selector: string): Iterable<FeedElement>;
}

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

/** Recovers ordinary text and CDATA converted to comments by the HTML parser. */
function elementText(element: FeedElement): string | null {
  const ordinaryText = element.textContent?.trim();
  if (ordinaryText) return ordinaryText;
  for (const child of element.childNodes) {
    if (child.nodeType !== 8) continue;
    const commentText = child.textContent?.trim() ?? "";
    const cdata = /^\[CDATA\[([\s\S]*)\]\]$/.exec(commentText);
    if (cdata?.[1]) return cdata[1];
  }
  return null;
}

function text(parent: FeedElement, selector: string): string | null {
  const element = parent.querySelector(selector);
  if (!element) return null;
  const value = elementText(element);
  if (value || selector !== "link") return value;

  // HTML parsing treats RSS <link> as a void element, leaving its value in the
  // following text node. Recover that standard RSS representation.
  let sibling = element.nextSibling;
  while (sibling?.nodeType === 3) {
    const siblingText = sibling.textContent?.trim();
    if (siblingText) return siblingText;
    sibling = sibling.nextSibling;
  }
  return null;
}

/** Finds namespaced elements without treating their colon as a CSS pseudo-class. */
function textByName(parent: FeedElement, localName: string): string | null {
  const lower = localName.toLowerCase();
  const pending = [...parent.children];
  while (pending.length > 0) {
    const child = pending.shift();
    if (!child) continue;
    if (child.localName.toLowerCase() === lower) {
      return elementText(child);
    }
    pending.push(...child.children);
  }
  return null;
}

function attr(
  parent: FeedElement,
  selector: string,
  attrName: string,
): string | null {
  const el = parent.querySelector(selector);
  return el?.getAttribute(attrName)?.trim() ?? null;
}

// ---------------------------------------------------------------------------
// RSS 2.0 extraction
// ---------------------------------------------------------------------------

function parseRssItems(root: FeedElement): FallbackFeedItem[] {
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

function parseAtomEntries(root: FeedElement): FallbackFeedItem[] {
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
    const body = document.body as unknown as FeedElement;

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
