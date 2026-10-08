import type { NavItem } from './nav.ts';

export interface SidebarProps {
  readonly panelName: string;
  readonly items: readonly NavItem[];
  readonly activeId: string;
  /** Resolves a label key through the app's message catalogue. */
  readonly label: (key: string) => string;
}

export function Sidebar({ panelName, items, activeId, label }: SidebarProps) {
  return (
    <aside className="flex flex-col border-e border-line bg-surface">
      <div className="flex h-(--mp-size-topbar) items-center border-b border-line px-4 font-semibold text-fg">
        {panelName}
      </div>
      <nav aria-label={panelName} className="flex flex-col gap-1 p-3">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <a
              key={item.id}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded-md bg-selected px-3 py-2 font-medium text-accent'
                  : 'rounded-md px-3 py-2 text-fg-secondary hover:bg-muted'
              }
            >
              {label(item.labelKey)}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
