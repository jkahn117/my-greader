# my-greader

A personal RSS aggregator backend that runs on Cloudflare Workers. It exposes a Google Reader-compatible API, so RSS readers with FreshRSS sync support can use it without a separate FreshRSS server. The project also includes an Access-protected web dashboard for managing subscriptions, API tokens, and feed activity.

## How it works

The Worker serves two interfaces:

- **RSS readers** use the Google Reader API and authenticate with an API token.
- **You** use the management dashboard, protected by Cloudflare Access.

Cloudflare D1 stores subscriptions, articles, read/star state, tokens, and polling history. A scheduled Cloudflare Workflow fetches feeds and records results. The dashboard reads durable activity from D1 and can show optional aggregate trends from Workers Analytics Engine.

The Worker is built with Hono and server-rendered JSX. The interface uses htmx and Tailwind CSS; feed parsing uses `rss-parser` with a lenient fallback.

## Fresh deployment

You’ll need a Cloudflare account, a domain managed in Cloudflare DNS, and Node.js with pnpm. The steps below assume the repository’s `wrangler.jsonc` is configured for your account and domain.

### 1. Configure your Worker and database

Edit `wrangler.jsonc`:

- Set a unique Worker `name`.
- Set the D1 `database_name` and replace `database_id` with the ID created below.
- Set the custom-domain `zone_name` and `pattern` to your domain and desired hostname (for example, `example.com` and `reader.example.com`). The hostname must be in a Cloudflare-managed zone.
- Set `CF_ACCOUNT_ID` and, if desired, `DISPLAY_TIMEZONE`.
- Set `LOGIN_RATE_LIMITER.namespace_id` to a unique value in your Cloudflare account.

Install dependencies and create the production database:

```bash
pnpm install
pnpm wrangler d1 create rss-reader
```

Copy the returned database ID into `wrangler.jsonc`. Apply the schema:

```bash
pnpm wrangler d1 migrations apply rss-reader --remote
```

### 2. Add the Worker domain and Cloudflare Access

Access needs to protect the dashboard while leaving API requests available to reader clients. You can configure two Self-hosted applications in Cloudflare Zero Trust for the planned hostname before the Worker is deployed:

1. **API bypass application:** hostname `reader.example.com`, path `/api/greader.php/*`, policy action **Bypass**, include **Everyone**. Bypass is required; an Allow policy redirects API clients to browser login. If your reader uses the supported `/reader/*` or `/accounts/ClientLogin` routes directly, add equivalent bypass applications for those paths.
2. **Dashboard application:** same hostname, no path, policy action **Allow**, include your email address. This protects the dashboard and other management routes.

From the dashboard application settings, copy the **Application Audience (AUD) Tag**. Find your Access team domain in Cloudflare One; the issuer is exactly `https://<team>.cloudflareaccess.com`, with no trailing slash.

### 3. Supply secrets and deploy

Create a temporary JSON file containing the required Access secrets and, optionally, the Analytics Engine read token:

```json
{
  "CF_ACCESS_AUD": "<audience-tag>",
  "CF_ACCESS_ISSUER": "https://<team>.cloudflareaccess.com"
}
```

Keep this file out of version control and remove it after uploading. To enable optional Analytics Engine dashboard queries, add `CF_API_TOKEN` to the JSON with a Cloudflare API token that has **Account Analytics Read** permission. Otherwise, leave it out entirely. Upload the secrets and deploy:

```bash
pnpm wrangler secret bulk <path-to-secrets.json>
pnpm deploy
```

The deploy provisions the custom Worker domain and DNS record. After deployment, open the dashboard hostname and confirm Access login works.

### 4. Connect an RSS reader

In Current, choose **Settings → Sync → FreshRSS**:

```
Server URL:  https://reader.example.com
Username:    your email address
Password:    API token from the dashboard's Access tab
```

The dashboard’s **Access** tab generates and revokes API tokens. Copy a token when it is shown; it is only displayed once. Other readers can connect if they support FreshRSS / Google Reader-compatible sync and accept a custom server URL.

### 5. Use the dashboard

Visit `https://reader.example.com` and sign in through Cloudflare Access. The dashboard includes:

- **Metrics:** article and reading summaries, recent polling activity, feed activity, and polling intervals. Optional Analytics Engine data adds longer-term trends and fetch/error statistics.
- **Feeds:** manage subscriptions and inspect feed status; import subscriptions using OPML.
- **Timeline:** review recent polling cycles and feed results.
- **Access:** create and revoke reader API tokens.

## Updating an existing deployment

Placeholder: document the routine update procedure here.

## Polling and retention

A scheduled Workflow checks feeds every 30 minutes. It processes eligible feeds in bounded batches, so the feed count is not limited to one cron invocation. Feeds with new articles are checked sooner; quiet feeds back off gradually, while rate limits and feed-provided timing hints are respected. Repeated errors can deactivate a feed, with the reason visible in the dashboard.

A weekly cleanup removes unstarred articles older than 30 days by default and expires polling history after 90 days. Starred articles are retained. Set `ITEM_RETENTION_DAYS` in `wrangler.jsonc` to change article retention. Set `ANALYTICS_ENABLED` to `"false"` to disable Analytics Engine writes and queries; core dashboard data remains available from D1.

## Local development

```bash
pnpm install
cp .dev.vars.sample .dev.vars
pnpm dev
```

Local development uses `DEV_MODE=true` from the sample file to bypass Access JWT verification. Never set `DEV_MODE` in production. Run `pnpm dev:css` in a separate terminal for CSS watch mode.

## Checks and useful commands

```bash
pnpm lint       # lint source and tests
pnpm test       # run both test modes
pnpm typecheck  # TypeScript checks
pnpm build      # production build
pnpm check      # all of the above
```

Other commands: `pnpm cf-typegen` regenerates Wrangler binding types, `pnpm studio` opens Drizzle Studio for local D1, and `pnpm format` formats TypeScript files.

## Further documentation

- [Architecture](docs/architecture.md) — module boundaries, persistence, polling, and observability
- [Authentication](docs/auth-flow.md) — Access verification and API token lifecycle
- [Google Reader API reference](docs/reference/greader-api.md) — protocol endpoints and compatibility
- [Architecture decisions](docs/decisions.md) — index of accepted ADRs
