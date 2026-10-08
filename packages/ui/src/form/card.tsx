import type { ReactNode } from 'react';

export interface CardProps {
  readonly title?: string;
  readonly children: ReactNode;
}

/** A bordered group of fields or rows with an optional heading. */
export function Card({ title, children }: CardProps) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      {title ? <h2 className="px-5 pt-5 text-lg font-semibold text-fg">{title}</h2> : null}
      <div className="flex flex-col gap-4 p-5">{children}</div>
    </section>
  );
}
