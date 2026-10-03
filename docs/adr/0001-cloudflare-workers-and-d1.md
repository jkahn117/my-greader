# Run the service on Cloudflare Workers and D1

The service runs on Cloudflare Workers with D1 rather than a VPS or container-hosted reader such as FreshRSS or Miniflux. This keeps the runtime, database, scheduled work, and static assets on the existing Cloudflare platform, avoiding a separate server to operate; the trade-off is designing around Workers and D1 execution limits.
