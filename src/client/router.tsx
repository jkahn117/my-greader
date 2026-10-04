/** @jsxImportSource react */
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import type { FeedsResponse, OverviewResponse } from "../shared/dashboard-api";
import { apiGet, ApiError } from "./lib/api";
import { Shell } from "./components/shell";
import {
  OverviewError,
  OverviewPage,
  OverviewPending,
} from "./routes/overview";
import { FeedsError, FeedsPage, FeedsPending } from "./routes/feeds";
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
  component: function FeedDetail() {
    const { feedId } = feedDetailRoute.useParams();
    return (
      <PlaceholderPage
        title="Feed detail"
        body={`Feed ${feedId} — the diagnosis and management view is being migrated to React.`}
      />
    );
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
  component: () => (
    <PlaceholderPage
      title="Access"
      body="API token management is being migrated to React."
    />
  ),
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
