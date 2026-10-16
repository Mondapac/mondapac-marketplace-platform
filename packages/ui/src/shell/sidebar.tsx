import { Icon } from '../icon/icon.tsx';
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
    <div className="flex flex-1 flex-col">
      <div className="flex h-(--mp-size-topbar-phone) shrink-0 items-center border-b border-line px-4 pe-14 font-semibold text-fg md:h-(--mp-size-topbar) md:pe-4">
        {panelName}
      </div>
      <nav aria-label={panelName} className="flex flex-col gap-1 overflow-y-auto p-3">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <a
              key={item.id}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'flex items-center gap-2.5 rounded-md bg-selected px-3 py-3 font-medium text-accent md:py-2'
                  : 'flex items-center gap-2.5 rounded-md px-3 py-3 text-fg-secondary hover:bg-muted hover:text-fg md:py-2'
              }
            >
              <Icon name={item.icon} className={active ? undefined : 'text-icon'} />
              <span className="min-w-0 break-words">{label(item.labelKey)}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
