'use client';

import { PageHeader, PeriodSelector, type PeriodOption } from '@mondapac/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useOptimistic, useTransition, type ReactNode } from 'react';
import { isKpiPeriod, type KpiPeriod } from './kpi-types.ts';

/**
 * The page title row with the period switch on its right (under the title on a phone), and the
 * figures it drives. The choice lives in the address
 * (`?period=`), so the server renders the figures; until it answers, the new choice is shown as
 * checked and the figures below are dimmed and marked busy, so a click never looks dead.
 */
export function PeriodSwitch({
  title,
  label,
  options,
  value,
  note,
  children,
}: {
  readonly title: string;
  readonly label: string;
  readonly options: readonly PeriodOption[];
  readonly value: KpiPeriod;
  /** Optional line next to the switch (what the change is compared with); the page has none. */
  readonly note?: string;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  return (
    <>
      <PageHeader
        title={title}
        actionsSlot={false}
        actions={
          <PeriodSelector
            label={label}
            options={options}
            value={shown}
            {...(note === undefined ? {} : { note })}
            onChange={(id) => {
              if (!isKpiPeriod(id)) return;
              start(() => {
                setShown(id);
                router.replace(`${pathname}?period=${id}`, { scroll: false });
              });
            }}
          />
        }
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
