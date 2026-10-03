# Feed fixture outcomes

No observed failure samples were attached to the ticket, so this corpus uses synthetic boundary cases. The fixtures use reserved `.test` hosts and invented names. They contain no credentials or personal data.

The supported outcomes are intentional:

- `rss-namespaces.xml`: namespace content and authors are normalized, XML entities are decoded, relative Item links resolve against the Feed URL when the document has no base, an invalid or absent date uses the Polling time, an Item without a GUID or link is skipped, and the first Item wins when one response repeats an identifier.
- `atom-alternate-links.xml`: the alternate link is preferred over other Atom links, relative Item links resolve against the document's `xml:base`, a missing Atom ID uses the alternate link as identity, and missing optional fields remain null or use the Polling time.
- `malformed-recoverable-rss.xml`: the missing closing tags make the primary parser reject the document. The production fallback parser recovers its Item and records `parser_status = 'fallback'`.

## Failure, blocking, and workload outcomes

HTML documents are not Feed content, even when HTTP status is 200 or the page embeds RSS-like markup. A successful HTTP response with an HTML document is a transient parse failure. A non-success HTTP response keeps the existing HTTP health classification, including permanent 403 errors. Diagnostics report HTTP status and HTML evidence without copying page content or inferring a vendor or an IP-based block. A `text/html` header on an otherwise valid RSS document alone does not make it a block page.

Unrecoverable XML fails without partial Item writes. Network rejection and response-body abort are exercised at the public transport interface; these tests do not prove the Workflow's real fetch deadline. Later valid content clears errors and preserves existing Items and identity.

The owner approved preserving current resource policy for #39. Item content is trimmed to 50 KiB of UTF-8 without splitting a character. Large generated response bodies and Item counts are accepted and deduplicated. These workloads are regression examples, not enforced body-size or Item-count limits. There are no new caps or retry policies.

Repeating Polling with any successful fixture must not create duplicate Items. An unrecoverable non-Feed response remains a parse failure; later valid Polling clears Feed health errors and stores the recovered Item.
