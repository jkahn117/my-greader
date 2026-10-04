/** @jsxImportSource react */
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import type {
  FeedDetailResponse,
  FeedsResponse,
  OverviewResponse,
  TokensResponse,
} from "../shared/dashboard-api";
import { apiGet, ApiError } from "./lib/api";
import { Shell } from "./components/shell";
import {
  OverviewError,
  OverviewPage,
  OverviewPending,
} from "./routes/overview";
import { FeedsError, FeedsPage, FeedsPending } from "./routes/feeds";
import {
  FeedDetailError,
  FeedDetailPage,
  FeedDetailPending,
} from "./routes/feed-detail";
import { AccessError, AccessPage, AccessPending } from "./routes/access";
import { PlaceholderPage } from "./routes/placeholder";

const rootRoute = createRootRoute({ component: Shell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/overview" });
  },
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/overview",
  pendingComponent: OverviewPending,
  errorComponent: ({ error }) => (
    <OverviewError
      status={error instanceof ApiError ? error.status : undefined}
    />
  ),
  loader: () => apiGet<OverviewResponse>("/app/api/overview"),
  component: function Overview() {
    const data = overviewRoute.useLoaderData();
    return <OverviewPage data={data} />;
  },
});

const feedsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feeds",
  pendingComponent: FeedsPending,
  errorComponent: ({ error }) => (
    <FeedsError status={error instanceof ApiError ? error.status : undefined} />
  ),
  loader: () => apiGet<FeedsResponse>("/app/api/feeds"),
  component: function Feeds() {
    const data = feedsRoute.useLoaderData();
    return <FeedsPage data={data} />;
  },
});

const feedDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/feeds/$feedId",
  pendingComponent: FeedDetailPending,
  errorComponent: ({ error }) => (
    <FeedDetailError
      status={error instanceof ApiError ? error.status : undefined}
    />
  ),
  loader: ({ params }) =>
    apiGet<FeedDetailResponse>(`/app/api/feeds/${params.feedId}`),
  component: function FeedDetail() {
    const data = feedDetailRoute.useLoaderData();
    return <FeedDetailPage key={data.feedId} data={data} />;
  },
});

const readingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reading",
  component: () => (
    <PlaceholderPage
      title="Reading"
      body="Reading metrics are being migrated to React."
    />
  ),
});

const accessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/access",
  pendingComponent: AccessPending,
  errorComponent: ({ error }) => (
    <AccessError
      status={error instanceof ApiError ? error.status : undefined}
    />
  ),
  loader: () => apiGet<TokensResponse>("/app/api/tokens"),
  component: function Access() {
    const data = accessRoute.useLoaderData();
    return <AccessPage data={data} />;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  overviewRoute,
  feedsRoute,
  feedDetailRoute,
  readingRoute,
  accessRoute,
]);

export const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
