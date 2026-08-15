# Coding style

Project-specific conventions that extend the global baseline.

## TypeScript

- Always use double quotes (strict; global says "prefer")
- Always use semicolons
- Strict mode

## CSS

- Tailwind v4 conventions for CSS variable names (design tokens)

## Validation

- **Valibot** for all API input validation: query params, form bodies, route params
- Import: `import * as v from "valibot"`

## Logging

- Use the structured JSON logger: `import { createLogger } from "../lib/logger"`
- Always pass request context via `logger.child({ rayId, userId, path })`
- **Never** use `console.log` directly in handlers

## Commenting

- Always include a comment on all but trivial functions.
- Focus on how the function / module fits into the larger application and its usage over what the function does.
