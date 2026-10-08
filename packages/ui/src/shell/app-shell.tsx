import type { ReactNode } from 'react';

export interface AppShellProps {
  readonly sidebar: ReactNode;
  readonly topbar: ReactNode;
  readonly children: ReactNode;
}

/** The one shell of both panels: sidebar column and a main column with the topbar (kickoff 2). */
export function AppShell({ sidebar, topbar, children }: AppShellProps) {
  return (
    <div className="grid min-h-screen grid-cols-[var(--mp-size-sidebar)_minmax(0,1fr)] bg-page">
      {sidebar}
      <div className="flex min-w-0 flex-col">
        {topbar}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
