'use client';

import { PeriodSelector, type PeriodOption } from '@mondapac/ui';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** The period switch of the KPI strip: choosing one reloads the home page with `?period=`. */
export function KpiPeriodSwitch({
  label,
  options,
  value,
  note,
}: {
  readonly label: string;
  readonly options: readonly PeriodOption[];
  readonly value: string;
  readonly note: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div aria-busy={pending}>
      <PeriodSelector
        label={label}
        options={options}
        value={value}
        note={note}
        onChange={(id) => start(() => router.push(`/?period=${id}`))}
      />
    </div>
  );
}
