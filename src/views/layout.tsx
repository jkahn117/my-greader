import { raw } from "hono/html";
import type { JSX } from "hono/jsx/jsx-runtime";

/**
 * HTML shell — wraps every server-rendered page.
 * Loads compiled Tailwind CSS and vendored htmx from /public.
 */
export function Layout({
  children,
}: {
  children: JSX.Element | JSX.Element[];
}) {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <title>RSS Reader</title>
          <link rel="stylesheet" href="/styles.css" />
        </head>
        <body class="min-h-screen bg-background font-sans antialiased">
          {children}
          <script src="/htmx.min.js" defer></script>
        </body>
      </html>
    </>
  );
}
