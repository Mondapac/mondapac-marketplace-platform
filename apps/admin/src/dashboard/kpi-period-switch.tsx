'use client';

import { PeriodSelector, type PeriodOption } from '@mondapac/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

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
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <div aria-busy={pending} className={pending ? 'opacity-60' : undefined}>
      <PeriodSelector
        label={label}
        options={options}
        value={pending && chosen !== null ? chosen : value}
        note={note}
        onChange={(id) => {
          setChosen(id);
          start(() => router.replace(`/?period=${id}`));
        }}
      />
    </div>
  );
}
