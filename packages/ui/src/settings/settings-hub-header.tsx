'use client';

import { Button } from '../form/button.tsx';
import { Icon } from '../icon/icon.tsx';
import { usePanelTools } from '../palette/panel-tools.tsx';

/**
 * The hub's title row: the page title and one sentence on the start side, a secondary Search
 * button on the end side that opens the same search (the palette) as the top bar and Ctrl or
 * Cmd+K. Without the panel tools around it, the button is left out.
 */
export function SettingsHubHeader({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  const tools = usePanelTools();
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-fg">{title}</h1>
        <p className="mt-1 max-w-prose text-sm text-fg-muted">{description}</p>
      </div>
      {tools === null ? null : (
        <Button
          variant="secondary"
          aria-haspopup="dialog"
          onClick={(event) => tools.openPalette(event.currentTarget)}
          className="shrink-0 gap-2"
        >
          <Icon name="search" />
          {tools.labels.search}
        </Button>
      )}
    </header>
  );
}
