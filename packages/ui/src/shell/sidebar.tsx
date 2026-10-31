import { navSections, splitNavPlacement, type NavGroup, type NavItem } from './nav.ts';
import { SidebarNav, type SidebarEntry } from './sidebar-nav.tsx';

export interface SidebarProps {
  readonly panelName: string;
  readonly items: readonly NavItem[];
  /** The topics for `NavItem.group`; absent means a flat list. */
  readonly groups?: readonly NavGroup[];
  readonly activeId: string;
  /** Resolves a label key through the app's message catalogue. */
  readonly label: (key: string) => string;
  /** Ids of the open groups from the `NAV_OPEN_COOKIE` cookie; the group of the active page opens too. */
  readonly openGroups?: readonly string[];
  /** Labels of the open-all / close-all button (shown with two or more groups). */
  readonly expandAll?: string;
  readonly collapseAll?: string;
}

// Inside the shell's column the sidebar can be an icon rail (`data-rail` on the `rail` group):
// labels stay for screen readers and every icon sits on the rail's centre line.
const RAIL_HIDDEN = 'group-data-[rail=true]/rail:sr-only';

export function Sidebar({
  panelName,
  items,
  groups,
  activeId,
  label,
  openGroups,
  expandAll,
  collapseAll,
}: SidebarProps) {
  const link = (item: NavItem) => ({
    id: item.id,
    href: item.href,
    icon: item.icon,
    label: label(item.labelKey),
  });
  // Resolved here, on the server: the client tree gets plain text, not the label function.
  const { menu, footer } = splitNavPlacement(items);
  const entries: SidebarEntry[] = navSections(groups, menu).map((section) =>
    section.kind === 'item'
      ? { kind: 'item', ...link(section.item) }
      : {
          kind: 'group',
          id: section.group.id,
          icon: section.group.icon,
          label: label(section.group.labelKey),
          items: section.items.map(link),
        },
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-(--mp-size-topbar-phone) shrink-0 items-center gap-(--mp-space-2-5) border-b border-line px-4 pe-14 font-semibold text-fg md:h-(--mp-size-topbar) md:pe-4 group-data-[rail=true]/rail:justify-center group-data-[rail=true]/rail:px-0">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent"
        >
          {panelName.charAt(0)}
        </span>
        <span className={`min-w-0 truncate ${RAIL_HIDDEN}`}>{panelName}</span>
      </div>
      <SidebarNav
        panelName={panelName}
        entries={entries}
        footer={footer.map(link)}
        activeId={activeId}
        openGroups={openGroups}
        expandAll={expandAll}
        collapseAll={collapseAll}
      />
    </div>
  );
}
