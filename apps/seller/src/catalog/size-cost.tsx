'use client';

import { Banner, Button, TextField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef } from 'react';
import type { CostsState } from '../price/cost.ts';
import { exponentOf, formatMinor, minorOf } from '../price/money.ts';
import { profitOf } from '../price/cost.ts';

/**
 * The Cost tab of one size (Offer page PR 7-UI; ux F41, C5). Private: only a seller with
 * `pricing.cost.view` gets the tab, and it stays hidden until they press "Show costs" (one press
 * shows the costs of every size of the offer; "Hide costs" hides them again). The seller types
 * the Cost of one unit, GST included; it is a draft of the table and is saved with "Save N
 * changes". Under it, "Estimated profit": "You receive (est.)" for the price customers pay now
 * less the Cost, and its share of that price. The Cost is never put in a title, a toast or an
 * attribute; only the field and the lines show it.
 */
export function SizeCost({
  id,
  sizeLabel,
  currency,
  costs,
  canEdit,
  text,
  saved,
  error,
  retired,
  youReceiveMinor,
  customerPaysMinor,
  receiveState,
  disabled,
  hideBlocked,
  onShow,
  onHide,
  onText,
}: {
  readonly id: string;
  readonly sizeLabel: string;
  readonly currency: string;
  readonly costs: CostsState;
  /** The seller may also change prices (`pricing.price.edit`): the field is editable. */
  readonly canEdit: boolean;
  /** The field's text: the typed Cost, or the recorded one in major units. */
  readonly text: string;
  /** The recorded Cost of this size in minor units; null when none; undefined when it takes none. */
  readonly saved: string | null | undefined;
  readonly error: string | undefined;
  readonly retired: boolean;
  /** "You receive (est.)" for the price customers pay now; null while read or when unknown. */
  readonly youReceiveMinor: string | null;
  readonly customerPaysMinor: string | null;
  /**
   * Why there is no "You receive (est.)": `hidden` when the seller may not see it, `none` without
   * a price, `pending` while it is read, `unavailable` when it can't be worked out.
   */
  readonly receiveState: 'ready' | 'hidden' | 'none' | 'pending' | 'unavailable';
  readonly disabled: boolean;
  /** Typed Costs are not saved yet: "Hide costs" waits until they are saved or discarded. */
  readonly hideBlocked: boolean;
  readonly onShow: () => void;
  readonly onHide: () => void;
  readonly onText: (text: string) => void;
}) {
  const t = useTranslations('price.cost');
  const locale = useLocale();
  const money = (amount: string) => formatMinor(amount, currency, locale);
  // One minus glyph (U+2212) for every negative on the tab, as in "− $9.00".
  const signed = (amount: string) =>
    amount.startsWith('-') ? `\u2212${money(amount.slice(1))}` : money(amount);
  const sectionRef = useRef<HTMLElement>(null);
  const privateNote = <p className="text-sm text-fg-muted">{t('private')}</p>;

  if (costs.kind === 'hidden' || costs.kind === 'loading') {
    return (
      <section aria-labelledby={`${id}-title`} className="flex max-w-xl flex-col gap-3">
        <h4 id={`${id}-title`} className="sr-only">
          {t('title')}
        </h4>
        {privateNote}
        <p className="text-sm">{t('hidden')}</p>
        <div>
          <Button variant="secondary" loading={costs.kind === 'loading'} onClick={onShow}>
            {t('show')}
          </Button>
        </div>
      </section>
    );
  }
  if (costs.kind === 'failed') {
    return (
      <section aria-labelledby={`${id}-title`} className="flex max-w-xl flex-col gap-3">
        <h4 id={`${id}-title`} className="sr-only">
          {t('title')}
        </h4>
        {privateNote}
        <Banner tone={costs.problem === 'acting-as' ? 'info' : 'critical'}>
          <p>{t(`error.${costs.problem}`)}</p>
        </Banner>
        {costs.problem === 'acting-as' || costs.problem === 'denied' ? null : (
          <div>
            <Button variant="secondary" onClick={onShow}>
              {t('retry')}
            </Button>
          </div>
        )}
      </section>
    );
  }

  const takesCost = saved !== undefined;
  const typed = minorOf(text, currency);
  // The profit follows the field: a typed Cost counts before it is saved, as the typed price does.
  const costMinor = text.trim() === '' ? null : typed;
  const profit = profitOf(youReceiveMinor, costMinor, customerPaysMinor);
  const unsaved = takesCost && costMinor !== saved && !(text.trim() === '' && saved === null);
  const negative = profit?.profitMinor.startsWith('-') === true;

  return (
    <section
      ref={sectionRef}
      aria-labelledby={`${id}-title`}
      // Typing brings up the save bar: the field and the profit lines stay above it (WCAG 2.4.11).
      className="flex max-w-xl scroll-mb-[calc(var(--mp-size-bottom-bar)_+_7rem)] flex-col gap-3 md:scroll-mb-28"
    >
      <h4 id={`${id}-title`} className="sr-only">
        {t('title')}
      </h4>
      {privateNote}
      {costs.notice === undefined ? null : (
        <Banner tone="attention">
          <p>{t('refresh-failed', { reason: t(`error.${costs.notice}`) })}</p>
        </Banner>
      )}
      {!takesCost ? (
        <p className="text-sm text-fg-muted">{t('not-priceable')}</p>
      ) : canEdit && !retired ? (
        // From sm up the field sits in the value column, like the lines under it (mock v4-3).
        <div className="flex flex-col gap-1 border-b border-line py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <span aria-hidden="true" className="shrink-0 font-medium sm:pt-2">
            {t('field', { currency })}
          </span>
          <div className="w-full sm:w-64 [&_input]:sm:text-end [&_label]:sr-only">
            <TextField
              name={`cost-${id}`}
              label={t('field', { currency })}
              aria-label={t('field-for', { currency, size: sizeLabel })}
              inputMode="decimal"
              autoComplete="off"
              value={text}
              error={error}
              disabled={disabled}
              onChange={(event) => {
                onText(event.target.value);
                requestAnimationFrame(() =>
                  sectionRef.current?.scrollIntoView?.({ block: 'nearest' }),
                );
              }}
            />
          </div>
        </div>
      ) : (
        <dl className="flex flex-col">
          <Line label={t('field', { currency })}>
            {saved === null ? (
              <span className="text-fg-muted">{t('none')}</span>
            ) : (
              <span className="tabular-nums">{money(saved)}</span>
            )}
          </Line>
        </dl>
      )}
      {takesCost ? (
        <dl className="flex flex-col">
          <Line label={t('you-receive')}>
            {receiveState === 'ready' && youReceiveMinor !== null ? (
              <span className="tabular-nums">
                {t('approx', { amount: money(youReceiveMinor) })}
              </span>
            ) : (
              <span className="text-sm text-fg-muted">{t(`receive.${receiveState}`)}</span>
            )}
          </Line>
          <Line label={t('your-cost')}>
            {costMinor === null || error !== undefined ? (
              <span className="text-sm text-fg-muted">
                {text.trim() === '' ? t('none') : '\u2014'}
              </span>
            ) : (
              <span className="tabular-nums">{t('minus', { amount: money(costMinor) })}</span>
            )}
          </Line>
          <Line label={<span className="font-semibold">{t('profit')}</span>}>
            {profit === null || receiveState !== 'ready' || error !== undefined ? (
              <span className="text-sm text-fg-muted">{'—'}</span>
            ) : (
              <>
                <span
                  className={`font-semibold tabular-nums ${negative ? 'text-critical-fg' : ''}`}
                >
                  {t('approx', { amount: signed(profit.profitMinor) })}
                </span>
                {profit.percent === null || customerPaysMinor === null ? null : (
                  <span className="ms-1 text-sm text-fg-muted tabular-nums">
                    {t('share', {
                      percent:
                        profit.percent < 0 ? `\u2212${-profit.percent}` : String(profit.percent),
                      price: money(customerPaysMinor),
                    })}
                  </span>
                )}
                {negative ? (
                  <span className="block text-sm text-critical-fg">{t('loss')}</span>
                ) : null}
              </>
            )}
          </Line>
        </dl>
      ) : null}
      {takesCost ? (
        <p className="text-sm text-fg-muted">
          {unsaved ? t('unsaved') : canEdit && !retired ? t('help') : t('help-read-only')}
        </p>
      ) : null}
      <div className="flex flex-col items-start gap-1">
        <Button
          variant="secondary"
          softDisabled={hideBlocked}
          aria-describedby={hideBlocked ? `${id}-hide-why` : undefined}
          onClick={onHide}
        >
          {t('hide')}
        </Button>
        {hideBlocked ? (
          <p id={`${id}-hide-why`} className="text-sm text-fg-muted">
            {t('hide-blocked')}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** One label and value line, as in the Price tab. */
function Line({
  label,
  children,
}: {
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-line py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <dt className="shrink-0">{label}</dt>
      <dd className="sm:text-end">{children}</dd>
    </div>
  );
}
