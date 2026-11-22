'use client';

import { PeriodSelector, type PeriodOption } from '@mondapac/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useOptimistic, useTransition, type ReactNode } from 'react';
import { isPeriod, type Period } from './types.ts';

/**
 * The period switch of the dashboard and the figures it drives. The choice lives in the address
 * (`?period=`), so the server renders the figures; until it answers, the new choice is shown as
 * checked and the figures below are dimmed and marked busy, so a click never looks dead.
 */
export function PeriodSwitch({
  label,
  options,
  value,
  note,
  children,
}: {
  readonly label: string;
  readonly options: readonly PeriodOption[];
  readonly value: Period;
  readonly note: string;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  return (
    <>
      <PeriodSelector
        label={label}
        options={options}
        value={shown}
        note={note}
        onChange={(id) => {
          if (!isPeriod(id)) return;
          start(() => {
            setShown(id);
            router.replace(`${pathname}?period=${id}`, { scroll: false });
          });
        }}
      />
      <div
        aria-busy={pending}
        className={`flex flex-col gap-4 transition-opacity ${pending ? 'opacity-60' : ''}`}
      >
        {children}
      </div>
    </>
  );
}
