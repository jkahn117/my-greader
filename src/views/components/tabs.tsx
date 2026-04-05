export type ActiveTab = 'metrics' | 'feed' | 'access'

interface TabItemProps {
  href: string
  label: string
  active: boolean
  disabled?: boolean
}

function TabItem({ href, label, active, disabled = false }: TabItemProps) {
  if (disabled) {
    return (
      <span class="cursor-not-allowed border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground/40 select-none">
        {label}
      </span>
    )
  }
  return (
    <a
      href={href}
      class={
        active
          ? 'border-b-2 border-primary px-4 py-2.5 text-sm font-medium text-foreground'
          : 'border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground'
      }
    >
      {label}
    </a>
  )
}

/** Tab navigation bar — sits directly below the header */
export function Tabs({ active }: { active: ActiveTab }) {
  return (
    <nav class="border-b border-border bg-card">
      <div class="mx-auto flex max-w-4xl gap-1 px-4">
        <TabItem href="/app/metrics" label="Metrics" active={active === 'metrics'} />
        <TabItem href="/app/feeds"  label="Feed"    active={active === 'feed'} />
        <TabItem href="/app/access" label="Access"  active={active === 'access'} />
      </div>
    </nav>
  )
}
