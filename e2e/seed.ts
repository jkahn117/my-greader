import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// All browser tests share one isolated local D1 instance; reseed before mutations.
export function seed(file: "seed-feeds.sql" | "seed-tokens.sql") {
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "rss-reader",
      "--local",
      "--persist-to",
      ".wrangler/e2e",
      "--config",
      "wrangler.jsonc",
      "--file",
      fileURLToPath(new URL(file, import.meta.url)),
    ],
    { stdio: "pipe", env: process.env },
  );
}
