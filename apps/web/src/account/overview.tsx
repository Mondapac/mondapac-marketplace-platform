'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import { AccountEmpty, AccountFrame, OrderBadge, useDay } from './account-area.tsx';
import { orderTotals, useAccount } from './account-state.tsx';

/** Overview: hello card, the latest order (or "No orders yet") and quick tiles. No Log out here. */
export function AccountOverview() {
  const t = useTranslations('account');
  const locale = useLocale();
  const day = useDay();
  const { profile, orders, addresses, lists } = useAccount();
  const { saved } = useStore();
  const [latest] = orders;
  const first = profile.fullName.trim().split(/\s+/)[0] ?? '';
  return (
    <AccountFrame title={t('titles.overview')}>
      <section className="ac-card">
        <div className="ac-hello">
          <span className="ac-av" aria-hidden="true">
            {first.charAt(0).toUpperCase()}
          </span>
          <div>
            <b>{t('overview.hello', { name: first })}</b>
            <small>{profile.email}</small>
          </div>
        </div>
      </section>
      {latest ? (
        <section className="ac-card" aria-labelledby="latest-order">
          <div className="ac-row">
            <h2 id="latest-order">{t('overview.latest')}</h2>
            <OrderBadge status={latest.status} />
          </div>
          <dl className="ac-dl">
            <div>
              <dt>{t('overview.order')}</dt>
              <dd>{latest.reference}</dd>
            </div>
            <div>
              <dt>{t('overview.placed')}</dt>
              <dd>{day(latest.placedOn)}</dd>
            </div>
            <div>
              <dt>{t('overview.total')}</dt>
              <dd className="num">{formatMoney(orderTotals(latest).total, locale)}</dd>
            </div>
          </dl>
          <div className="ac-acts">
            <Link className="btn" href={`/account/orders/${latest.id ?? latest.reference}`}>
              {t('overview.view-order')}
            </Link>
            <Link className="btn ghost" href="/account/orders">
              {t('overview.all-orders')}
            </Link>
          </div>
        </section>
      ) : (
        <AccountEmpty icon="bag" title={t('no-orders')}>
          <p>{t('no-orders-body')}</p>
          <Link className="btn" href="/">
            {t('browse')}
          </Link>
        </AccountEmpty>
      )}
      <div className="ac-quick">
        <Link className="ac-q" href="/account/addresses">
          <Icon name="pin" />
          <b>{t('nav.addresses')}</b>
          <span>{t('overview.addresses-count', { count: addresses.length })}</span>
        </Link>
        <Link className="ac-q" href="/account/lists">
          <Icon name="heart" />
          <b>{t('nav.lists')}</b>
          <span>{t('overview.lists-count', { count: saved.length + lists.length })}</span>
        </Link>
        <Link className="ac-q" href="/account/settings">
          <Icon name="gear" />
          <b>{t('nav.settings')}</b>
          <span>{t('overview.settings-body')}</span>
        </Link>
      </div>
    </AccountFrame>
  );
}
