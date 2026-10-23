'use client';

import { useTranslations } from 'next-intl';
import { Icon } from '../icons/icon.tsx';

/** Where the buyer is on the way to an order. */
export type CheckoutStage = 'cart' | 'login' | 'pay' | 'done';

/**
 * The checkout progress bar on the cart, checkout, payment, not-paid and confirmation pages: Cart,
 * Log in (guests only), Delivery and payment, Confirmation; earlier steps are ticked. From 900px it
 * is one row with joining lines; below, each step is a circle over its label. The line before a
 * step is its ::before, so the list holds only list items.
 */
export function CheckoutProgress({
  current,
  signedIn,
}: {
  readonly current: CheckoutStage;
  readonly signedIn: boolean;
}) {
  const t = useTranslations('checkout');
  const stages: readonly CheckoutStage[] = signedIn
    ? ['cart', 'pay', 'done']
    : ['cart', 'login', 'pay', 'done'];
  const at = stages.indexOf(current);
  return (
    <ol className="ckst" aria-label={t('progress')}>
      {stages.map((stage, i) => (
        <li
          key={stage}
          className={i < at ? 'dn' : i === at ? 'cur' : undefined}
          aria-current={i === at ? 'step' : undefined}
        >
          <span className="n" aria-hidden="true">
            {i < at ? <Icon name="check" /> : i + 1}
          </span>
          <span className="t">
            {t(`progress-${stage}`)}
            {i < at ? <span className="sr-only">{t('progress-complete')}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
