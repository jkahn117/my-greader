# Feed fixture outcomes

No observed failure samples were attached to the ticket, so this corpus uses synthetic boundary cases. The fixtures use reserved `.test` hosts and invented names. They contain no credentials or personal data.

The supported outcomes are intentional:

- `rss-namespaces.xml`: namespace content and authors are normalized, XML entities are decoded, relative Item links resolve against the Feed URL when the document has no base, an invalid or absent date uses the Polling time, an Item without a GUID or link is skipped, and the first Item wins when one response repeats an identifier.
- `atom-alternate-links.xml`: the alternate link is preferred over other Atom links, relative Item links resolve against the document's `xml:base`, a missing Atom ID uses the alternate link as identity, and missing optional fields remain null or use the Polling time.
- `malformed-recoverable-rss.xml`: the missing closing tags make the primary parser reject the document. The production fallback parser recovers its Item and records `parser_status = 'fallback'`.

Repeating Polling with any successful fixture must not create duplicate Items. An unrecoverable non-Feed response remains a parse failure; later valid Polling clears Feed health errors and stores the recovered Item.
