# Coding style

Project-specific conventions that extend the global baseline.

## TypeScript

- Always use double quotes (strict; global says "prefer")
- Always use semicolons
- Strict mode

## CSS

- Tailwind v4 conventions for CSS variable names (design tokens)

## Validation

- **Zod v4** for all API input validation: query params, form bodies, route params
- Import: `import { z } from "zod"`

## Logging

- Use the structured JSON logger: `import { createLogger } from "../lib/logger"`
- Always pass request context via `logger.child({ rayId, userId, path })`
- **Never** use `console.log` directly in handlers
