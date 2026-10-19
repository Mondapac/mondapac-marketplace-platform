import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { Icon } from '../../src/icons/icon.tsx';

// The account hub. Sign-in, orders and saved lists arrive with the customer auth screens; the
// display settings work now and are kept per browser.
export default async function AccountPage() {
  const t = await getTranslations('account');
  return (
    <div className="state">
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <Link className="seller" href="/account/personalization">
        <span className="lg" aria-hidden="true">
          <Icon name="user" />
        </span>
        <b>{t('personalization')}</b>
        <span className="mn">{t('personalization-body')}</span>
      </Link>
    </div>
  );
}
