# Upstream provenance

- Source repository: `dmmulroy/anti-slop`
- Source revision: unknown. The installed skill did not include a commit identifier.
- Source snapshot: `.agents/skills/install-anti-slop/assets/anti-slop/`
- Skill snapshot hash from `skills-lock.json`: `4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`
- Installed generic plugin: `tools/oxlint/anti-slop/index.ts`
- Installed Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`

## Intentional deviations

The copied files are unchanged from the bundled skill snapshot except for this provenance file. The generic plugin is enabled. The Effect plugin remains installed but disabled because this repository does not declare `effect` as a direct dependency.

The vendored readability implementation has separate license and provenance records under `vendor/eslint-stylistic/`.
