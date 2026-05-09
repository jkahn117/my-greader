// Hono context variables set by middleware.
// Shared across all route handlers.
import type { WideEventVariables } from "@workers-powertools/hono/logger";

export type Variables = WideEventVariables & {
  userId: string;
  email: string;
};
