'use client';

import { Button } from '../form/button.tsx';
import { Icon } from '../icon/icon.tsx';
import { PageHeader } from '../help/page-header.tsx';
import { usePanelTools } from '../palette/panel-tools.tsx';

/**
 * The hub's title row: the page title on the start side, a secondary Search
 * button on the end side that opens the same search (the palette) as the top bar and Ctrl or
 * Cmd+K. Without the panel tools around it, the button is left out.
 */
export function SettingsHubHeader({ title }: { readonly title: string }) {
  const tools = usePanelTools();
  return (
    <PageHeader
      title={title}
      {...(tools === null
        ? {}
        : {
            actions: (
              <Button
                variant="secondary"
                aria-haspopup="dialog"
                onClick={(event) => tools.openPalette(event.currentTarget)}
                className="shrink-0 gap-2"
              >
                <Icon name="search" />
                {tools.labels.search}
              </Button>
            ),
          })}
    />
  );
}
