# Upstream provenance

- Source repository: `dmmulroy/anti-slop`
- Source revision: unknown. The installed skill did not include a commit identifier.
- Historical project bundle: Git commit `19ec685cd764951d71d9f8a6cacd34acc5ec7d8d`, path `.agents/skills/install-anti-slop/assets/anti-slop/`. The project-local skills and lockfile were subsequently removed. That commit recovers the former local bundle, with Effect already removed, not a pristine upstream base.
- Original installed-skill snapshot hash, recorded before local removal of Effect rules: `4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`
- Installed generic plugin: `tools/oxlint/anti-slop/index.ts`

## Intentional deviations

The generic plugin remains enabled. The optional Effect plugin, its five rules, and its helper were intentionally removed because this project will not use Effect. Preserve that generic-only policy during future updates. Removing the project skills did not change the installed plugin implementation or its licenses. The original snapshot hash above identifies the skill before the local Effect removal; the upstream source revision remains unknown.

The vendored readability implementation has separate license and provenance records under `vendor/eslint-stylistic/`.
