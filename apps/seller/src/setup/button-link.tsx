import Link from 'next/link';
import type { ReactNode } from 'react';

const VARIANT = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'border border-line-control bg-surface text-fg hover:bg-muted',
} as const;

/** A link that looks like a Button (navigation, not an action). */
export function ButtonLink({
  href,
  variant,
  children,
}: {
  readonly href: string;
  readonly variant: keyof typeof VARIANT;
  readonly children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex h-(--mp-size-control) items-center rounded-md px-4 font-medium ${VARIANT[variant]}`}
    >
      {children}
    </Link>
  );
}
