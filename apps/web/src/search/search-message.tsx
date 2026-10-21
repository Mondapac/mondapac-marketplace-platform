import type { ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';

/** A centred message card: no results, the prompts before a search, and the error. */
export function SearchMessage({
  icon,
  title,
  body,
  live,
  children,
}: {
  readonly icon: 'search' | 'info' | 'warn';
  readonly title: string;
  readonly body?: string;
  /** `status` for a short note that replaces the results, `alert` for the error. */
  readonly live?: 'status' | 'alert';
  readonly children?: ReactNode;
}) {
  return (
    <div className="sr-empty" role={live}>
      <Icon name={icon} />
      <h2>{title}</h2>
      {body ? <p>{body}</p> : null}
      {children}
    </div>
  );
}
