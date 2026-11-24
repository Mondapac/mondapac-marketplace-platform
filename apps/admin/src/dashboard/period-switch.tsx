'use client';

import {
  ActionMenu,
  Button,
  PageHeader,
  PeriodSelector,
  TextField,
  toast,
  type PeriodOption,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from 'react';
import { downloadSalesExport, ExportFailure } from '../sales/sales-export.tsx';
import {
  DAILY_EXPORT_PATH,
  dailyExportQuery,
  earliestFrom,
  selectionHref,
  validateRange,
  type KpiSelection,
  type RangeField,
} from './kpi-range.ts';
import { longDay, PERIOD_KEY } from './kpi-format.ts';
import { isKpiPeriod, type KpiPeriodId } from './kpi-types.ts';

/** The message of one refused field of the range, in words (never the API's own path). */
function useFieldError(fields: readonly RangeField[], today: string, to: string) {
  const t = useTranslations('dashboard.kpis.range');
  const locale = useLocale();
  const message = (code: string): string =>
    /^[a-z-]+$/.test(code) && t.has(`error.${code}`)
      ? t(`error.${code}` as 'error.required', {
          earliest: longDay(earliestFrom(to), locale),
          today: longDay(today, locale),
        })
      : t('error.unknown');
  return {
    field: (path: 'from' | 'to'): string | undefined => {
      const found = fields.find((f) => f.path === path);
      return found === undefined ? undefined : message(found.code);
    },
    /** A refusal that belongs to neither day (a code the API added, an unknown path). */
    general: fields.some((f) => f.path !== 'from' && f.path !== 'to') ? t('error.general') : null,
  };
}

/**
 * The Export button of the page header: the report of the shown period or range as CSV or XLSX,
 * fetched through the panel's relay. A 403 hides the button (the session may not export after
 * all); any other failure is a toast. A custom range that is not valid cannot be exported.
 */
function ReportExport({
  selection,
  zone,
  today,
}: {
  readonly selection: KpiSelection;
  readonly zone: string;
  readonly today: string;
}) {
  const t = useTranslations('dashboard.kpis.export');
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  if (hidden) return null;
  const invalid =
    selection.id === 'custom' &&
    validateRange({ from: selection.from, to: selection.to, today }).length > 0;

  async function start(format: 'csv' | 'xlsx') {
    setBusy(true);
    try {
      await downloadSalesExport({
        path: DAILY_EXPORT_PATH,
        query: dailyExportQuery(selection, format),
        format,
        fallbackName: 'marketplace-daily',
        zone,
        knownRows: null,
      });
      toast.success(t('done'), { id: 'dashboard-export' });
    } catch (reason) {
      if (reason instanceof ExportFailure && reason.reason === 'denied') {
        toast.error(t('denied'), { id: 'dashboard-export' });
        setHidden(true);
      } else {
        const unavailable = !(reason instanceof ExportFailure) || reason.reason === 'unavailable';
        toast.error(t(unavailable ? 'error.unavailable' : 'error.invalid'), {
          id: 'dashboard-export',
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionMenu
      label={t('label')}
      title={t('title')}
      disabled={busy || invalid}
      {...(invalid ? { hint: t('invalid-range') } : {})}
      items={[
        {
          id: 'csv',
          label: t('csv'),
          description: t('csv-help'),
          icon: 'download',
          onSelect: () => void start('csv'),
        },
        {
          id: 'xlsx',
          label: t('xlsx'),
          description: t('xlsx-help'),
          icon: 'download',
          onSelect: () => void start('xlsx'),
        },
      ]}
    />
  );
}

/** The from/to pickers of a custom range, with the refusals under their fields. */
function RangeForm({
  from,
  to,
  today,
  fields,
  busy,
  showing,
  focusSignal,
  onChange,
  onApply,
}: {
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly fields: readonly RangeField[];
  readonly busy: boolean;
  /** What the figures show now, named for the "until you apply" note. */
  readonly showing: string | null;
  /** Changes after every refused Apply, so focus goes to the first invalid field. */
  readonly focusSignal: number;
  readonly onChange: (next: { from: string; to: string }) => void;
  readonly onApply: () => void;
}) {
  const t = useTranslations('dashboard.kpis.range');
  const { field, general } = useFieldError(fields, today, to);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (focusSignal === 0) return;
    formRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
  }, [focusSignal]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply();
  };
  return (
    <form
      ref={formRef}
      aria-label={t('label')}
      onSubmit={submit}
      noValidate
      className="flex flex-wrap items-start gap-3 rounded-lg border border-line bg-surface p-3"
    >
      <TextField
        label={t('from')}
        type="date"
        name="from"
        value={from}
        min={earliestFrom(to)}
        max={today}
        error={field('from')}
        announceError
        onChange={(event) => onChange({ from: event.target.value, to })}
      />
      <TextField
        label={t('to')}
        type="date"
        name="to"
        value={to}
        max={today}
        error={field('to')}
        announceError
        onChange={(event) => onChange({ from, to: event.target.value })}
      />
      <div className="flex flex-col gap-1.5 self-end">
        <Button type="submit" disabled={busy}>
          {t('apply')}
        </Button>
      </div>
      {general === null ? null : (
        <p role="alert" className="w-full text-sm text-critical-fg">
          {general}
        </p>
      )}
      <p className="w-full text-xs text-fg-muted">{t('help', { today })}</p>
      {showing === null ? null : (
        <p className="w-full text-xs text-fg-muted">{t('showing', { period: showing })}</p>
      )}
    </form>
  );
}

/**
 * The page title row with the period switch and the Export button on its right (under the title
 * on a phone), and the figures they drive. The choice lives in the address (`?period=`, and for
 * Custom `&from=&to=`), so the server renders the figures. Choosing Custom opens the from/to
 * pickers; Apply checks the range as the API does (13 months at most, ending by the Market's
 * today) and shows what is wrong under the field. Until the server answers, the new choice shows
 * as checked and the figures are dimmed and marked busy, so a click never looks dead.
 */
export function PeriodSwitch({
  title,
  label,
  options,
  selection,
  today,
  zone,
  fields,
  canExport,
  children,
}: {
  readonly title: string;
  readonly label: string;
  readonly options: readonly PeriodOption[];
  readonly selection: KpiSelection;
  /** The Market's day now (`YYYY-MM-DD`): the last day a range may end on. */
  readonly today: string;
  /** The IANA zone the file's times are written in. */
  readonly zone: string;
  /** Refusals of the range in the address, shown under its fields. */
  readonly fields: readonly RangeField[];
  /** The session holds the three keys of the export. */
  readonly canExport: boolean;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic<KpiPeriodId>(selection.id);
  const [editing, setEditing] = useState(selection.id === 'custom');
  const [range, setRange] = useState({
    from: selection.id === 'custom' ? selection.from : '',
    to: selection.id === 'custom' ? selection.to : today,
  });
  const [attempts, setAttempts] = useState(0);
  const [problems, setProblems] = useState<readonly RangeField[]>(fields);

  const tp = useTranslations('dashboard.kpis.period');
  const locale = useLocale();
  // A refused range in the address shows no figures, so there is nothing to say is "shown".
  const refused =
    selection.id === 'custom' &&
    validateRange({ from: selection.from, to: selection.to, today }).length > 0;
  const showing = refused
    ? null
    : selection.id === 'custom'
      ? `${longDay(selection.from, locale)} to ${longDay(selection.to, locale)}`
      : tp(PERIOD_KEY[selection.id] as 'today');

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
                if (!isKpiPeriod(id)) return;
                setEditing(false);
                setProblems([]);
                start(() => {
                  setShown(id);
                  router.replace(selectionHref({ id }), { scroll: false });
                });
              }}
            />
            {canExport ? <ReportExport selection={selection} zone={zone} today={today} /> : null}
          </>
        }
      />
      {editing ? (
        <RangeForm
          {...range}
          today={today}
          fields={problems}
          busy={pending}
          showing={showing}
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
