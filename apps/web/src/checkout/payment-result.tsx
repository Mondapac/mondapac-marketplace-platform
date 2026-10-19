'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { viewCart } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';

// The pages around Stripe's hosted payment page: the sample stand-in for it, "Payment not
// completed" (Stripe's cancel URL) and the confirmation (its success URL).

/**
 * Stands in for the redirect to Stripe's hosted Checkout page until payment is wired: no Stripe
 * call and no order is made; it only lets the two ways back be tried on sample data.
 */
export function SamplePayment({ reference }: { readonly reference: string }) {
  const t = useTranslations('checkout');
  const router = useRouter();
  const { cart, cartSource, clearCart, deliveryAddress, setPlacedOrder } = useStore();
  const view = viewCart(cart, cartSource);
  return (
    <div className="cwrap">
      <div className="done">
        <div className="cnote" role="status">
          <Icon name="info" />
          <p>
            <b>{t('sample-title')}</b> {t('sample-body')}
          </p>
        </div>
        <div className="dact">
          {view ? (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setPlacedOrder({ reference, view, address: deliveryAddress });
                clearCart();
                router.push('/checkout/confirmation');
              }}
            >
              {t('sample-paid')}
            </button>
          ) : null}
          <Link className="btn ghost" href="/checkout/not-completed">
            {t('sample-cancel')}
          </Link>
        </div>
      </div>
    </div>
  );
}

export function PaymentNotCompleted() {
  const t = useTranslations('checkout');
  return (
    <div className="cwrap">
      <div className="done">
        <div className="cnote" role="alert">
          <Icon name="info" />
          <p>{t.rich('not-paid', { b: (chunks) => <b>{chunks}</b> })}</p>
        </div>
        <h1 className="dtitle">{t('try-again')}</h1>
        <p className="legal">{t('not-paid-body')}</p>
        <div className="dact">
          <Link className="btn" href="/checkout/payment">
            {t('pay-again')}
          </Link>
          <Link className="btn ghost" href="/cart">
            {t('back-to-cart')}
          </Link>
        </div>
      </div>
    </div>
  );
}

export function Confirmation() {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const { placedOrder: order, customer } = useStore();
  if (!order || !customer)
    return (
      <div className="cwrap">
        <div className="done">
          <h1 className="dtitle">{t('title')}</h1>
          <p>{t('no-order')}</p>
          <div className="dact">
            <Link className="btn" href="/">
              {t('continue-shopping')}
            </Link>
          </div>
        </div>
      </div>
    );
  return (
    <div className="cwrap">
      <div className="done">
        <div className="okc">
          <span className="tk">
            <Icon name="check" />
          </span>
          <h1>{t('thanks', { name: customer.firstName })}</h1>
          <p>
            {t('placed', {
              reference: order.reference,
              total: formatMoney(order.view.total, locale),
              email: customer.email,
            })}
          </p>
        </div>
        <div className="infob">
          <Icon name="truck" />
          <span>{t('split-done')}</span>
        </div>
        {order.view.groups.map((g, n) => (
          <article className="dord" key={g.seller.id}>
            <header>
              <h2>{g.seller.name}</h2>
              <span className="badge">{t('waiting-seller')}</span>
            </header>
            <small className="legal">
              {t('part', {
                reference: `${order.reference}-${n + 1}`,
                window: g.seller.deliveryWindow,
              })}
            </small>
            <ul>
              {g.lines.map((l) => (
                <li key={l.id}>{t('line', { quantity: l.quantity, name: l.item.name })}</li>
              ))}
            </ul>
          </article>
        ))}
        <div className="dord">
          <h2>{t('delivering-to')}</h2>
          <span>{order.address}</span>
        </div>
        <div className="dact">
          <Link className="btn" href="/account">
            {t('view-orders')}
          </Link>
          <Link className="btn ghost" href="/">
            {t('continue-shopping')}
          </Link>
        </div>
      </div>
    </div>
  );
}
