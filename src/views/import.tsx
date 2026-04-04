interface ImportResultProps {
  imported:   number
  duplicates: number
  errors:     string[]
}

/** htmx fragment — returned by POST /import and swapped into #import-result */
export function ImportResult({ imported, duplicates, errors }: ImportResultProps) {
  const hasErrors = errors.length > 0

  return (
    <div class="rounded-md border border-border bg-card p-4 text-sm space-y-2">
      <p class="font-medium text-foreground">Import complete</p>
      <ul class="space-y-0.5 text-muted-foreground">
        <li>
          <span class="font-medium text-foreground">{imported}</span>
          {imported === 1 ? ' feed imported' : ' feeds imported'}
        </li>
        {duplicates > 0 && (
          <li>
            <span class="font-medium text-foreground">{duplicates}</span>
            {duplicates === 1 ? ' duplicate skipped' : ' duplicates skipped'}
          </li>
        )}
        {hasErrors && (
          <li class="text-destructive">
            <span class="font-medium">{errors.length}</span>
            {errors.length === 1 ? ' feed failed' : ' feeds failed'}
          </li>
        )}
      </ul>
      {hasErrors && (
        <details>
          <summary class="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Show failed URLs
          </summary>
          <ul class="mt-1.5 space-y-0.5">
            {errors.map(url => (
              <li class="font-mono text-xs text-destructive truncate">{url}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
