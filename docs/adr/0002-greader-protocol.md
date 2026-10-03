# Use the Google Reader protocol through FreshRSS-compatible sync

The backend exposes the Google Reader API dialect used by FreshRSS clients, rather than implementing a reader-specific API. Current accepts a custom server URL in its FreshRSS sync mode, making this protocol the practical integration seam without requiring a FreshRSS installation; other clients can connect when they support compatible sync.
