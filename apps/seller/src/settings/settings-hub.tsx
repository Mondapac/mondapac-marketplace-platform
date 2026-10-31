import { Badge, Icon } from '@mondapac/ui';
import type { VisibleSettingsGroup } from './settings-nav.ts';

export interface SettingsHubLabels {
  readonly viewOnly: string;
}

/**
 * The Settings hub: one card per group, one link per page the caller may open. A link of a page
 * the caller can only view carries a "View only" chip. A group with no visible link is not drawn
 * (`visibleSettings` leaves it out); the page shows the no-access state when nothing is left.
 */
export function SettingsHub({
  groups,
  label,
  labels,
}: {
  readonly groups: readonly VisibleSettingsGroup[];
  /** Resolves a label key through the app's messages. */
  readonly label: (key: string) => string;
  readonly labels: SettingsHubLabels;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 min-[1500px]:grid-cols-3">
      {groups.map(({ group, links }) => (
        <section
          key={group.id}
          aria-labelledby={`settings-group-${group.id}`}
          className="overflow-hidden rounded-lg border border-line bg-surface"
        >
          <h2
            id={`settings-group-${group.id}`}
            className="flex items-center gap-2.5 px-5 pb-3 pt-5 text-base font-semibold text-fg"
          >
            <Icon name={group.icon} className="text-icon" />
            {label(group.labelKey)}
          </h2>
          <ul className="border-t border-line">
            {links.map(({ link, viewOnly }) => (
              <li key={link.id} className="border-b border-line last:border-b-0">
                <a
                  href={link.href}
                  className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-2 text-fg hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                >
                  <span className="min-w-0 break-words">{label(link.labelKey)}</span>
                  {viewOnly ? (
                    <span className="shrink-0">
                      <Badge tone="neutral">{labels.viewOnly}</Badge>
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
