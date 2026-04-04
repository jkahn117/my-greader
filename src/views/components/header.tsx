/** Top bar — app name left, email badge + logout link right */
export function Header({ email }: { email: string }) {
  return (
    <header class="border-b border-border bg-card">
      <div class="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
        <span class="text-sm font-semibold tracking-tight">RSS Reader</span>
        <div class="flex items-center gap-3">
          <span class="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {email}
          </span>
          <a
            href="/auth/logout"
            class="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Logout
          </a>
        </div>
      </div>
    </header>
  )
}
