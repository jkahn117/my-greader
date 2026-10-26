# Upstream provenance

- Source repository: `dmmulroy/anti-slop`
- Source revision: unknown. The installed skill did not include a commit identifier.
- Source snapshot: `.agents/skills/install-anti-slop/assets/anti-slop/`
- Original skill snapshot hash from `skills-lock.json`, before local removal of Effect rules: `4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`
- Installed generic plugin: `tools/oxlint/anti-slop/index.ts`

## Intentional deviations

The generic plugin is enabled and its source is unchanged. The optional Effect plugin, its five rules, and its helper were intentionally removed from both this installation and the bundled skill assets because this project will not use Effect. The skill's installation guidance was updated to preserve this choice during future updates. The original snapshot hash above identifies the upstream skill before these local changes.

The vendored readability implementation has separate license and provenance records under `vendor/eslint-stylistic/`.
