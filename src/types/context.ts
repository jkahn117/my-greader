// Hono context variables set by auth middleware (Access or token).
// Shared across all route handlers.
export type Variables = {
  userId: string;
  email: string;
};
