'use client';

import { PeriodSelector, type PeriodOption } from '@mondapac/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { isPeriod, type Period } from './types.ts';

/** The period switch of the dashboard: the choice lives in the address (`?period=`), so the server renders the figures. */
export function PeriodSwitch({
  label,
  options,
  value,
  note,
}: {
  readonly label: string;
  readonly options: readonly PeriodOption[];
  readonly value: Period;
  readonly note: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  return (
    <div aria-busy={pending}>
      <PeriodSelector
        label={label}
        options={options}
        value={value}
        note={note}
        onChange={(id) => {
          if (!isPeriod(id)) return;
          start(() => router.replace(`${pathname}?period=${id}`, { scroll: false }));
        }}
      />
    </div>
  );
}
