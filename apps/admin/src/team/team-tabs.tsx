/** The two tabs of "Roles & permissions" (ux B1, B2): links, with the current one marked. */
export function TeamTabs({
  active,
  labels,
}: {
  readonly active: 'admins' | 'roles';
  /** Absent when the actor may not see roles: the page then has no tabs. */
  readonly labels: { readonly nav: string; readonly admins: string; readonly roles: string } | null;
}) {
  if (labels === null) return null;
  const tabs = [
    { id: 'admins', href: '/team', label: labels.admins },
    { id: 'roles', href: '/roles', label: labels.roles },
  ] as const;
  return (
    <nav aria-label={labels.nav} className="mb-4 flex gap-4 border-b border-line">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === active ? 'page' : undefined}
          className={
            tab.id === active
              ? 'border-b-2 border-link px-1 pb-2 font-medium text-fg'
              : 'px-1 pb-2 text-fg-muted hover:text-fg'
          }
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}

/** The tab labels from a translator (server pages). */
export function tabLabels(t: (key: string) => string) {
  return {
    nav: t('identity.members.tab.label'),
    admins: t('identity.members.tab.admins'),
    roles: t('identity.members.tab.roles'),
  };
}
