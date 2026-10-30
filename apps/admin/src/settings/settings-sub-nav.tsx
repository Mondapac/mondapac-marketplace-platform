import type { ReactNode } from 'react';

export interface SubNavGroup {
  readonly id: string;
  readonly label: string;
  readonly links: readonly { readonly id: string; readonly href: string; readonly label: string }[];
}

/**
 * The second navigation column inside Settings: the same groups and links as the hub, already
 * filtered to what the caller may open, with the current page marked. It shows from 1180 px (the
 * caller decides where); below that the pages offer a "Back to Settings" link instead.
 */
export function SettingsSubNav({
  label,
  groups,
  activeId,
}: {
  readonly label: string;
  readonly groups: readonly SubNavGroup[];
  readonly activeId: string;
}): ReactNode {
  if (groups.length === 0) return null;
  return (
    <nav aria-label={label} className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col gap-1">
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            {group.label}
          </p>
          {group.links.map((link) => {
            const active = link.id === activeId;
            return (
              <a
                key={link.id}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-10 items-center rounded-md px-3 py-1 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
                  active
                    ? 'bg-selected font-medium text-link'
                    : 'text-fg-secondary hover:bg-muted hover:text-fg'
                }`}
              >
                <span className="min-w-0 break-words">{link.label}</span>
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
