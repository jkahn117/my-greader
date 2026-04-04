// Augment Hono's JSX HTML attributes to allow htmx directive attributes.
// Without this, TypeScript rejects hx-* on intrinsic HTML elements.
declare module 'hono/jsx' {
  namespace JSX {
    interface HTMLAttributes {
      'hx-get'?:       string
      'hx-post'?:      string
      'hx-put'?:       string
      'hx-delete'?:    string
      'hx-patch'?:     string
      'hx-swap'?:      string
      'hx-swap-oob'?:  string
      'hx-target'?:    string
      'hx-trigger'?:   string
      'hx-confirm'?:   string
      'hx-encoding'?:  string
      'hx-push-url'?:  string
      'hx-include'?:   string
      'hx-boost'?:     string
      'hx-vals'?:      string
      'hx-headers'?:   string
      'hx-indicator'?: string
      'hx-select'?:    string
    }
  }
}
