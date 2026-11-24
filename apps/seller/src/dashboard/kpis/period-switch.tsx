'use client';

import {
  earliestFrom,
  PageHeader,
  PeriodSelector,
  RangeForm,
  ReportExportMenu,
  validateRange,
  type PeriodOption,
  type RangeField,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useOptimistic, useState, useTransition, type ReactNode } from 'react';
import { DAILY_EXPORT_PATH, dailyExportQuery, selectionHref, type Selection } from './range.ts';
import { isPeriod, type ShownPeriod } from './types.ts';

/** "23 Nov 2026" for a Market day, read as that calendar day whatever the viewer's zone. */
export function longDay(day: string, locale: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** The message of each refused field of the range, in words (never the API's own path). */
function useRangeErrors(fields: readonly RangeField[], today: string, to: string) {
  const t = useTranslations('dashboard.kpi.range');
  const locale = useLocale();
  const message = (code: string): string =>
    /^[a-z-]+$/.test(code) && t.has(`error.${code}`)
      ? t(`error.${code}` as 'error.required', {
          earliest: longDay(earliestFrom(to), locale),
          today: longDay(today, locale),
        })
      : t('error.unknown');
  const of = (path: 'from' | 'to'): string | undefined => {
    const found = fields.find((f) => f.path === path);
    return found === undefined ? undefined : message(found.code);
  };
  return {
    from: of('from'),
    to: of('to'),
    /** A refusal that belongs to neither day (a code the API added, an unknown path). */
    general: fields.some((f) => f.path !== 'from' && f.path !== 'to') ? t('error.general') : null,
  };
}

/**
 * The page title row with the period switch and the Export button on its right (under the title
 * on a phone), and the figures they drive. The choice lives in the address (`?period=`, and for
 * Custom `&from=&to=`), so the server renders the figures; until it answers, the new choice is
 * shown as checked and the figures below are dimmed and marked busy, so a click never looks dead.
 * Choosing Custom opens the from/to pickers; Apply checks the range as the API does (13 months at
 * most, ending by today) and says what is wrong under the field. No subtitle: the title row holds
 * the title and the buttons only.
 */
export function PeriodSwitch({
  title,
  label,
  options,
  selection,
  today,
  zone,
  canExport,
  children,
}: {
  readonly title: string;
  readonly label: string;
  readonly options: readonly PeriodOption[];
  readonly selection: Selection;
  /** The day now (`YYYY-MM-DD`): the last day a range may end on. */
  readonly today: string;
  /** The IANA zone the file name's day is read in. */
  readonly zone: string | null;
  /** The session holds the two keys of the export. */
  readonly canExport: boolean;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const t = useTranslations('dashboard.kpi.range');
  const te = useTranslations('dashboard.kpi.export');
  const tp = useTranslations('dashboard.kpi.period');
  const locale = useLocale();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic<ShownPeriod>(selection.id);
  const [editing, setEditing] = useState(selection.id === 'custom');
  const [range, setRange] = useState({
    from: selection.id === 'custom' ? selection.from : '',
    to: selection.id === 'custom' ? selection.to : today,
  });
  const refusedInAddress =
    selection.id === 'custom'
      ? validateRange({ from: selection.from, to: selection.to, today })
      : [];
  const [problems, setProblems] = useState<readonly RangeField[]>(refusedInAddress);
  const [attempts, setAttempts] = useState(0);
  const errors = useRangeErrors(problems, today, range.to);

  // A refused range in the address shows no figures, so there is nothing to say is "shown".
  const unchanged =
    selection.id === 'custom' && range.from === selection.from && range.to === selection.to;
  // Nothing to say while the pickers equal what is shown (or while nothing is shown at all).
  const showing =
    refusedInAddress.length > 0 || unchanged
      ? null
      : selection.id === 'custom'
        ? `${longDay(selection.from, locale)} to ${longDay(selection.to, locale)}`
        : tp(selection.id);

  const apply = () => {
    const found = validateRange({ ...range, today });
    setProblems(found);
    if (found.length > 0) {
      setAttempts((n) => n + 1);
      return;
    }
    if (selection.id === 'custom' && selection.from === range.from && selection.to === range.to) {
      // Nothing changed: close the form, the figures already are this range.
      setEditing(false);
      return;
    }
    start(() => {
      setShown('custom');
      router.replace(selectionHref({ id: 'custom', ...range }), { scroll: false });
    });
  };

  return (
    <>
      <PageHeader
        title={title}
        actionsSlot={false}
        actions={
          <>
            <PeriodSelector
              label={label}
              options={options}
              value={editing ? 'custom' : shown}
              onChange={(id) => {
                if (id === 'custom') {
                  setEditing(true);
                  return;
                }
                if (!isPeriod(id)) return;
                setEditing(false);
                setProblems([]);
                start(() => {
                  setShown(id);
                  router.replace(selectionHref({ id }), { scroll: false });
                });
              }}
            />
            {canExport ? (
              <ReportExportMenu
                labels={{
                  button: te('label'),
                  title: te('title'),
                  csv: te('csv'),
                  csvHelp: te('csv-help'),
                  xlsx: te('xlsx'),
                  xlsxHelp: te('xlsx-help'),
                  done: te('done'),
                  denied: te('denied'),
                  invalidFile: te('error.invalid'),
                  unavailable: te('error.unavailable'),
                  invalidRange: te('invalid-range'),
                }}
                path={DAILY_EXPORT_PATH}
                queryFor={(format) => dailyExportQuery(selection, format)}
                fallbackName="seller-daily"
                zone={zone}
                disabled={refusedInAddress.length > 0}
              />
            ) : null}
          </>
        }
      />
      {editing ? (
        <RangeForm
          labels={{ form: t('label'), from: t('from'), to: t('to'), apply: t('apply') }}
          from={range.from}
          to={range.to}
          min={earliestFrom(range.to)}
          max={today}
          fromError={errors.from}
          toError={errors.to}
          generalError={errors.general}
          help={t('help', { today: longDay(today, locale) })}
          showing={showing === null ? null : t('showing', { period: showing })}
          busy={pending}
          focusSignal={attempts}
          onChange={setRange}
          onApply={apply}
        />
      ) : null}
      <div
        aria-busy={pending}
        className={`flex flex-col gap-4 transition-opacity ${pending ? 'opacity-60' : ''}`}
      >
        {children}
      </div>
    </>
  );
}
