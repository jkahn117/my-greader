// Wrangler generates configured bindings and required secrets. Optional secrets
// and local-only values still need explicit declarations.
interface Env {
  CF_API_TOKEN?: string;
  DEV_MODE?: string;
}
