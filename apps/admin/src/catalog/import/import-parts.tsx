'use client';

import { Banner, CARD_TABLE, Card, Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { keyOfCode, type ImportErrorLine, type ImportFailureLine } from './import-types.ts';

// The pieces of the Import products page (Figma "Import" · `pi*`): the steps bar, the file row, the
// meter, the summary tiles, the tables and the footer. Presentation only; the page owns the state.

/** Three steps across the full width; each takes an equal share and its line fills the rest. */
export function ImportSteps({ active }: { readonly active: 1 | 2 | 3 }) {
  const t = useTranslations('catalog.import.steps');
  const steps = ['upload', 'check', 'import'] as const;
  return (
    <Card>
      <ol aria-label={t('label')} className="flex w-full items-center gap-3">
        {steps.map((step, index) => {
          const number = index + 1;
          const done = number < active;
          const on = number === active;
          return (
            <li
              key={step}
              aria-current={on ? 'step' : undefined}
              className={`flex min-w-0 items-center gap-2 ${number < 3 ? 'flex-1' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  on || done
                    ? 'bg-accent text-on-accent'
                    : 'border border-line-control bg-surface text-fg-muted'
                }`}
              >
                {done ? <Icon name="check" className="size-3.5" /> : number}
              </span>
              <span
                className={`min-w-0 text-sm ${on ? 'font-semibold text-fg' : done ? 'text-fg' : 'text-fg-muted'}`}
              >
                {t(step)}
                {done ? <span className="sr-only"> {t('done')}</span> : null}
              </span>
              {number < 3 ? (
                <span
                  aria-hidden="true"
                  className={`h-0.5 min-w-2.5 flex-1 ${done ? 'bg-accent' : 'bg-line'}`}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** A titled card of the page: heading, an optional line under it, then the content. */
export function ImportSection({
  title,
  sub,
  children,
}: {
  readonly title: string;
  readonly sub?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {sub === undefined ? null : <p className="text-sm text-fg-muted">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

/** The uploaded file: its (cleaned) name, a line of facts and an optional action. */
export function FileRow({
  name,
  meta,
  action,
}: {
  readonly name: string;
  readonly meta: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3">
      <Icon name="clipboard" className="size-5 shrink-0 text-fg-muted" />
      <div className="flex min-w-0 flex-1 basis-48 flex-col">
        <span className="break-words text-sm font-semibold text-fg">{name}</span>
        <span className="text-xs text-fg-muted">{meta}</span>
      </div>
      {action}
    </div>
  );
}

/** A progress bar. Without a value it only shows that work is going on. */
export function Meter({
  label,
  value,
}: {
  readonly label: string;
  /** 0 to 100, or null while the amount is not known. */
  readonly value: number | null;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={`h-full rounded-full bg-accent ${value === null ? 'w-1/3 motion-safe:animate-pulse' : ''}`}
        style={value === null ? undefined : { width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export interface Tile {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'success' | 'critical' | 'attention';
  readonly note?: string;
}

const TONE_TEXT = {
  success: 'text-success-fg',
  critical: 'text-critical-fg',
  attention: 'text-attention-fg',
} as const;

/** The count tiles of the check and of the report. */
export function ImportTiles({ tiles }: { readonly tiles: readonly Tile[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <li
          key={tile.label}
          className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-4"
        >
          <span className="text-sm font-semibold text-fg-secondary">{tile.label}</span>
          <span
            className={`text-2xl font-semibold tabular-nums ${tile.tone === undefined ? 'text-fg' : TONE_TEXT[tile.tone]}`}
          >
            {tile.value}
          </span>
          {tile.note === undefined ? null : (
            <span className="text-xs text-fg-muted">{tile.note}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The footer of a step: Cancel at the start, the other actions at the end. */
export function ImportFooter({
  start,
  end,
}: {
  readonly start?: ReactNode;
  readonly end?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line pt-4">
      {start}
      <div className="ms-auto flex flex-wrap items-center justify-end gap-3">{end}</div>
    </div>
  );
}

/** The class of a link that looks like a link in a footer or a table caption. */
export const LINK_CLASS =
  'inline-flex min-h-(--mp-size-control-sm) items-center gap-1.5 text-sm font-medium text-link underline-offset-2 hover:underline';

function problemKey(t: ReturnType<typeof useTranslations>, code: string): string {
  const key = `problem.${keyOfCode(code)}`;
  return t.has(key) ? key : 'problem.other';
}

/** The rows with errors: row, column, the value in the file, and the problem, in words. */
export function ErrorTable({
  lines,
  total,
  reportHref,
}: {
  readonly lines: readonly ImportErrorLine[];
  /** Rows with errors in the file, which may be more than the lines shown. */
  readonly total: number;
  readonly reportHref: string;
}) {
  const t = useTranslations('catalog.import');
  return (
    <Card flush>
      <div className="overflow-x-auto">
        <table className={CARD_TABLE.table}>
          <caption className="sr-only">{t('errors.caption')}</caption>
          <thead className={CARD_TABLE.head}>
            <tr className="border-b border-line text-fg-muted">
              <th scope="col" className="w-20 px-4 py-3 text-start font-medium">
                {t('errors.row')}
              </th>
              <th scope="col" className="w-44 px-4 py-3 text-start font-medium">
                {t('errors.column')}
              </th>
              <th scope="col" className="px-4 py-3 text-start font-medium">
                {t('errors.value')}
              </th>
              <th scope="col" className="w-80 px-4 py-3 text-start font-medium">
                {t('errors.problem')}
              </th>
            </tr>
          </thead>
          <tbody className={CARD_TABLE.body}>
            {lines.map((line, index) => (
              <tr key={`${line.rowNumber}-${line.column}-${index}`} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} font-semibold tabular-nums text-fg`}>
                  <span className="lg:sr-only">{t('errors.row')} </span>
                  {line.rowNumber}
                </td>
                <td className={`${CARD_TABLE.labelled} text-fg`} data-label={t('errors.column')}>
                  {t.has(`column.${line.column}`) ? t(`column.${line.column}`) : line.column}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} min-w-0 break-all text-fg-secondary lg:min-w-56`}
                  data-label={t('errors.value')}
                >
                  {line.value === '' ? t('errors.empty') : line.value}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} text-critical-fg`}
                  data-label={t('errors.problem')}
                >
                  {t(problemKey(t, line.code), {
                    column: t.has(`column.${line.column}`)
                      ? t(`column.${line.column}`)
                      : line.column,
                    row: line.otherRow ?? 0,
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-fg-muted">
          {t('errors.showing', { shown: lines.length, total })}
        </p>
        <a className={LINK_CLASS} href={reportHref} download>
          <Icon name="download" className="size-4" />
          {t('errors.download')}
        </a>
      </div>
    </Card>
  );
}

/** The rows a run did not add, with the reason. */
export function FailureTable({ lines }: { readonly lines: readonly ImportFailureLine[] }) {
  const t = useTranslations('catalog.import');
  return (
    <Card flush>
      <div className="overflow-x-auto">
        <table className={CARD_TABLE.table}>
          <caption className="sr-only">{t('failures.caption')}</caption>
          <thead className={CARD_TABLE.head}>
            <tr className="border-b border-line text-fg-muted">
              <th scope="col" className="w-20 px-4 py-3 text-start font-medium">
                {t('errors.row')}
              </th>
              <th scope="col" className="px-4 py-3 text-start font-medium">
                {t('failures.title')}
              </th>
              <th scope="col" className="w-96 px-4 py-3 text-start font-medium">
                {t('failures.reason')}
              </th>
            </tr>
          </thead>
          <tbody className={CARD_TABLE.body}>
            {lines.map((line) => (
              <tr key={line.rowNumber} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} font-semibold tabular-nums text-fg`}>
                  <span className="lg:sr-only">{t('errors.row')} </span>
                  {line.rowNumber}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} min-w-0 break-words text-fg lg:min-w-48`}
                  data-label={t('failures.title')}
                >
                  {line.title}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} text-fg-secondary`}
                  data-label={t('failures.reason')}
                >
                  {t.has(`failure.${keyOfCode(line.code)}`)
                    ? t(`failure.${keyOfCode(line.code)}`)
                    : t('failure.other')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The first rows of a clean file. */
export function PreviewTable({
  rows,
  total,
}: {
  readonly rows: readonly {
    readonly rowNumber: number;
    readonly title: string;
    readonly category: string;
    readonly typeCode: string;
    readonly brand: string;
  }[];
  readonly total: number;
}) {
  const t = useTranslations('catalog.import');
  return (
    <Card flush>
      <div className="overflow-x-auto">
        <table className={CARD_TABLE.table}>
          <caption className="sr-only">{t('preview.caption')}</caption>
          <thead className={CARD_TABLE.head}>
            <tr className="border-b border-line text-fg-muted">
              <th scope="col" className="px-4 py-3 text-start font-medium">
                {t('column.title')}
              </th>
              <th scope="col" className="w-44 px-4 py-3 text-start font-medium">
                {t('column.category')}
              </th>
              <th scope="col" className="w-40 px-4 py-3 text-start font-medium">
                {t('column.type')}
              </th>
              <th scope="col" className="w-40 px-4 py-3 text-start font-medium">
                {t('column.brand')}
              </th>
            </tr>
          </thead>
          <tbody className={CARD_TABLE.body}>
            {rows.map((row) => (
              <tr key={row.rowNumber} className={CARD_TABLE.row}>
                <td
                  className={`${CARD_TABLE.cell} min-w-0 break-words font-semibold text-fg lg:min-w-48`}
                >
                  {row.title}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} break-words text-fg`}
                  data-label={t('column.category')}
                >
                  {row.category}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} break-words text-fg`}
                  data-label={t('column.type')}
                >
                  {row.typeCode}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} break-words text-fg`}
                  data-label={t('column.brand')}
                >
                  {row.brand === '' ? t('preview.no-brand') : row.brand}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="p-4 text-sm text-fg-muted">
        {t('preview.first', { shown: rows.length, total })}
      </p>
    </Card>
  );
}

/** Inactive or Active: two choices side by side, one pressed. */
export function StartAsChoice({
  value,
  onChange,
  disabled,
  inactiveAllowed,
}: {
  readonly value: 'inactive' | 'active';
  readonly onChange: (next: 'inactive' | 'active') => void;
  readonly disabled: boolean;
  /** False when the admin may not pause: Inactive cannot be chosen. */
  readonly inactiveAllowed: boolean;
}) {
  const t = useTranslations('catalog.import.settings');
  const items = ['inactive', 'active'] as const;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 basis-48 flex-col">
        <span id="start-as-label" className="text-sm font-semibold text-fg">
          {t('start-as')}
        </span>
        <span className="text-sm text-fg-muted">
          {inactiveAllowed ? t('start-as-help') : t('start-as-no-pause')}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="start-as-label"
        className="inline-flex overflow-hidden rounded-md border border-line-control bg-surface"
      >
        {items.map((item, index) => {
          const on = value === item;
          const off = disabled || (item === 'inactive' && !inactiveAllowed);
          return (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={off}
              onClick={() => onChange(item)}
              className={`flex min-h-(--mp-size-control) items-center whitespace-nowrap px-3.5 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed ${
                index > 0 ? 'border-s border-line-control' : ''
              } ${on ? 'bg-selected font-semibold text-link' : 'text-fg-secondary enabled:hover:bg-muted disabled:text-fg-muted'}`}
            >
              {t(item)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A problem of the upload, under the file, with what to do next. */
export function ProblemBanner({
  tone,
  title,
  body,
}: {
  readonly tone: 'critical' | 'attention';
  readonly title: string;
  readonly body: string;
}) {
  return (
    <Banner tone={tone} title={title}>
      <p>{body}</p>
    </Banner>
  );
}
