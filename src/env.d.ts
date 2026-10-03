// Wrangler generates configured bindings, but secrets and local-only values
// are not present in wrangler.jsonc and need explicit declarations.
interface Env {
  CF_ACCESS_AUD?: string;
  CF_ACCESS_ISSUER?: string;
  CF_API_TOKEN?: string;
  DEV_MODE?: string;
}
