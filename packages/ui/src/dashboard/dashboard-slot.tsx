import { Suspense, use, type ReactNode } from 'react';

/**
 * What a dashboard section reads: the answer itself, or a promise of it while the page streams.
 * A server page starts every read and passes the promises, so each card shows as soon as its own
 * read answers; a test (or a page that already has the answers) passes the values.
 */
export type DashboardSource<T> = T | Promise<T>;

function isPromise<T>(source: DashboardSource<T>): source is Promise<T> {
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as { then?: unknown }).then === 'function'
  );
}

function Resolved<T>({
  source,
  children,
}: {
  readonly source: Promise<T>;
  readonly children: (value: T) => ReactNode;
}) {
  return <>{children(use(source))}</>;
}

/**
 * Panel loading L4: one section of a dashboard that loads on its own. A promise renders the
 * fallback (the section's skeleton) until it answers, so one slow read never holds the rest of
 * the page; a value renders at once.
 */
export function DashboardSlot<T>({
  source,
  fallback,
  children,
}: {
  readonly source: DashboardSource<T>;
  readonly fallback: ReactNode;
  readonly children: (value: T) => ReactNode;
}) {
  if (!isPromise(source)) return <>{children(source)}</>;
  return (
    <Suspense fallback={fallback}>
      <Resolved source={source}>{children}</Resolved>
    </Suspense>
  );
}
