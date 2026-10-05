# my-greader

A personal RSS aggregator backend that runs on Cloudflare Workers. It exposes a Google Reader-compatible API, so RSS readers with FreshRSS sync support can use it without a separate FreshRSS server. The project also includes an Access-protected web dashboard for managing subscriptions, API tokens, and feed activity.

## How it works

The Worker serves two interfaces:

- **RSS readers** use the Google Reader API and authenticate with an API token.
- **You** use the management dashboard, protected by Cloudflare Access.

Cloudflare D1 stores subscriptions, articles, read/star state, tokens, and polling history. A scheduled Cloudflare Workflow fetches feeds and records results. The dashboard reads durable activity from D1 and can show optional aggregate trends from Workers Analytics Engine.

The Worker uses Hono for HTTP APIs. The management dashboard is a React SPA built with Vite, TanStack Router, shadcn components, and Tailwind CSS, served as Workers static assets under `/app`. It calls same-origin JSON endpoints under `/app/api/*`. Feed parsing uses `rss-parser` with a lenient fallback.

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

Visit `https://reader.example.com/app` and sign in through Cloudflare Access. The dashboard includes:

- **Overview** (`/app/overview`): Item and marked-read summaries, Feed health, latest Cycle Run lifecycle, and needs-attention links. Optional Analytics Engine data adds a 30-day trend.
- **Feeds** (`/app/feeds`): filter Subscriptions, import OPML, and start normal or forced polling. Open a Feed for its health, deactivate/reactivate controls, and paginated durable attempt history with attributed Items.
- **Reading** (`/app/reading`): marked-read metrics over 7, 14, or 30 display-timezone calendar days. These describe current Item State and server receipt times, not reading sessions or time spent reading.
- **Access** (`/app/access`): create and revoke reader API Tokens, and copy FreshRSS connection settings.

The former server-rendered `/app/metrics` and `/app/timeline` pages and top-level `/tokens/*`, `/feeds/*`, and `/import` management endpoints are no longer supported. Reader protocol routes are unchanged.

## Updating an existing deployment

Back up the production D1 database and review pending SQL migrations before updating. The combined release keeps the ordered `drizzle/*.sql` migrations from `next`; do not substitute migrations from the original React branch. Apply pending migrations before deploying the new Worker:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm wrangler d1 migrations apply rss-reader --remote
pnpm deploy
```

`pnpm deploy` builds both the React client (`dist/client`) and Worker (`dist/my_greader`) before deployment. Keep the hostname-wide Access application: it must cover `/app`, `/app/api/*`, and client assets, not just the old management paths. Keep reader bypass policies narrowly scoped to the reader routes, never `/api/*` or `/app/api/*`. Confirm both Access login and Current sync after deployment. These are operator steps, not an indication that this release has passed its checks.

## Polling and retention

A scheduled Workflow checks feeds every 30 minutes. It processes eligible feeds in bounded batches, so the feed count is not limited to one cron invocation. Feeds with new articles are checked sooner; quiet feeds back off gradually, while rate limits and feed-provided timing hints are respected. Repeated errors can deactivate a feed, with the reason visible in the dashboard.

A weekly cleanup (Mondays 03:00 UTC) removes unstarred Items fetched more than 30 days ago by default and expires polling history after 90 days, in bounded batches. An Item starred by any User is retained; expired attempt references are detached from retained Items before history deletion. Revoked API Tokens are removed after at least seven days. Set `ITEM_RETENTION_DAYS` in `wrangler.jsonc` to change article retention. Set `ANALYTICS_ENABLED` to `"false"` to disable Analytics Engine writes and queries; core dashboard data remains available from D1.

## Local development

```bash
pnpm install
cp .dev.vars.sample .dev.vars
pnpm wrangler d1 migrations apply rss-reader --local
pnpm dev
```

`pnpm dev` supplies `DEV_MODE=true` through a serve-only Vite override to bypass Access JWT verification locally. Production builds do not include this override. Never set `DEV_MODE` in production. Run `pnpm dev:css` in a separate terminal for CSS watch mode.

## Checks and useful commands

```bash
pnpm lint       # lint source and tests
pnpm test       # run both test modes
pnpm typecheck  # TypeScript checks
pnpm build      # CSS + React client + Worker production build
pnpm check      # all of the above
pnpm test:browser # Playwright acceptance tests against the local Vite server
```

Browser tests automatically apply migrations in the isolated `.wrangler/e2e` store and supply local-only authentication overrides. Vitest applies migrations in its own isolated D1 stores. `pnpm dev` runs Vite with the Cloudflare plugin, not a separate frontend service.

Other commands: `pnpm cf-typegen` regenerates Wrangler binding types, `pnpm studio` opens Drizzle Studio for local D1, and `pnpm format` formats TypeScript files.

## Further documentation

- [Architecture](docs/architecture.md) — module boundaries, persistence, polling, and observability
- [Authentication](docs/auth-flow.md) — Access verification and API token lifecycle
- [Google Reader API reference](docs/reference/greader-api.md) — protocol endpoints and compatibility
- [Architecture decisions](docs/decisions.md) — index of accepted ADRs
