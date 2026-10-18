import { getTranslations } from 'next-intl/server';
import { cookies } from 'next/headers';
import { CONSENT_COOKIE, consentOf } from '../../src/consent/consent.ts';
import { CookieSettings } from '../../src/consent/cookie-settings.tsx';

export async function generateMetadata() {
  const t = await getTranslations('cookies');
  return { title: t('title') };
}

const NECESSARY = ['session', 'cart', 'palette', 'text-size', 'consent'] as const;

export default async function CookiesPage() {
  const t = await getTranslations('cookies');
  const jar = await cookies();
  return (
    <div className="state cookies">
      <h1>{t('title')}</h1>
      <p>{t('intro')}</p>
      <section className="cookie-group" aria-labelledby="cookies-necessary">
        <div className="cookie-head">
          <h2 id="cookies-necessary">{t('necessary')}</h2>
          <span className="cookie-on">{t('always-on')}</span>
        </div>
        <p>{t('necessary-body')}</p>
        <ul className="cookie-list">
          {NECESSARY.map((key) => (
            <li key={key}>
              <b>{t(`list.${key}`)}</b>
              <span>{t(`list.${key}-body`)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="cookie-group" aria-labelledby="cookies-optional">
        <h2 id="cookies-optional">{t('optional')}</h2>
        <CookieSettings initial={consentOf(jar.get(CONSENT_COOKIE)?.value)} />
      </section>
    </div>
  );
}
