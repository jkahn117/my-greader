import {
  parseFeed as parseWithFeedsmith,
  type AtomFeed,
  type RdfFeed,
  type RssFeed,
} from "feedsmith";
import { XMLValidator } from "fast-xml-parser";

export interface ParsedFeedItem {
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

export interface ParsedFeed {
  title: string | null;
  link: string | null;
  ttl: number | null;
  items: ParsedFeedItem[];
}

/** Keeps invalid dates absent so polling can apply its fetched-time fallback. */
function validDate(value: string | undefined): string | null {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

/** Selects one human-readable identity from format-specific person fields. */
function personName(
  person:
    | RssFeed.Person
    | AtomFeed.Person
    | { name?: string; email?: string }
    | undefined,
): string | null {
  return person?.name ?? person?.email ?? null;
}

/** Normalizes RSS fields behind the parser seam used by Feed polling. */
function normalizeRss(feed: RssFeed.Feed<string>): ParsedFeed {
  return {
    title: feed.title ?? null,
    link: feed.link ?? null,
    ttl: feed.ttl ?? null,
    items: (feed.items ?? []).map((item) => ({
      guid: item.guid?.value ?? null,
      title: item.title ?? null,
      link: item.link ?? null,
      content: item.description ?? null,
      contentEncoded: item.content?.encoded ?? null,
      summary: item.description ?? null,
      contentSnippet: null,
      creator: item.dc?.creators?.[0] ?? personName(item.authors?.[0]),
      author: personName(item.authors?.[0]),
      // rss-parser selected pubDate before dc:date, even if pubDate was invalid.
      isoDate: validDate(item.pubDate || item.dc?.dates?.[0]),
    })),
  };
}

/** Normalizes Atom links and text constructs into the polling field model. */
function normalizeAtom(feed: AtomFeed.Feed<string>): ParsedFeed {
  return {
    title: feed.title?.value ?? null,
    link:
      feed.links?.find((link) => link.rel === "alternate")?.href ??
      feed.links?.[0]?.href ??
      null,
    ttl: null,
    items: (feed.entries ?? []).map((entry) => {
      const author = personName(entry.authors?.[0]);
      return {
        // rss-parser exposed Atom id separately, so polling used the resolved URL.
        guid: null,
        title: entry.title?.value ?? null,
        link:
          entry.links?.find((link) => link.rel === "alternate")?.href ??
          entry.links?.[0]?.href ??
          null,
        content: entry.content?.value ?? null,
        contentEncoded: entry.content?.value ?? null,
        summary: entry.summary?.value ?? null,
        contentSnippet: null,
        creator: author,
        author,
        isoDate: validDate(entry.published ?? entry.updated),
      };
    }),
  };
}

/** Normalizes RSS 1.0/RDF fields into the polling field model. */
function normalizeRdf(feed: RdfFeed.Feed<string>): ParsedFeed {
  return {
    title: feed.title ?? null,
    link: feed.link ?? null,
    ttl: null,
    items: (feed.items ?? []).map((item) => ({
      // rdf:about was not a guid in rss-parser; retain URL-derived Item IDs.
      guid: null,
      title: item.title ?? null,
      link: item.link ?? null,
      content: item.description ?? null,
      contentEncoded: item.content?.encoded ?? null,
      summary: item.description ?? null,
      contentSnippet: null,
      creator: item.dc?.creators?.[0] ?? null,
      author: null,
      isoDate: validDate(item.dc?.dates?.[0]),
    })),
  };
}

/** Parses a well-formed XML Feed and hides Feedsmith's format-specific models. */
export function parseFeed(xml: string): ParsedFeed {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Malformed XML: ${validation.err.msg}`);
  }

  const parsed = parseWithFeedsmith(xml);
  switch (parsed.format) {
    case "rss":
      return normalizeRss(parsed.feed);
    case "atom":
      return normalizeAtom(parsed.feed);
    case "rdf":
      return normalizeRdf(parsed.feed);
    case "json":
      throw new Error("JSON Feed is not supported by XML polling");
  }
}
