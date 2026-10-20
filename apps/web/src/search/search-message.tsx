import type { ReactNode } from 'react';
import { Icon } from '../icons/icon.tsx';

/** A centred message card: no results, the prompts before a search, and the error. */
export function SearchMessage({
  icon,
  title,
  body,
  alert,
  children,
}: {
  readonly icon: 'search' | 'info';
  readonly title: string;
  readonly body?: string;
  readonly alert?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="sr-empty" role={alert ? 'alert' : 'status'}>
      <Icon name={icon} />
      <h2>{title}</h2>
      {body ? <p>{body}</p> : null}
      {children}
    </div>
  );
}
