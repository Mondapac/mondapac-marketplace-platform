import { getTranslations } from 'next-intl/server';
import { Icon } from '../icons/icon.tsx';
import type { IconName } from '../icons/icon-paths.tsx';
import type { SellerSignUpSetup } from '../storefront/types.ts';
import { SellFaq } from './sell-faq.tsx';
import { SellerSignUpCard } from './seller-sign-up-card.tsx';

const BENEFITS: readonly { readonly key: string; readonly icon: IconName }[] = [
  { key: 'halal', icon: 'seal' },
  { key: 'delivery', icon: 'truck' },
  { key: 'store', icon: 'store' },
];
const QUESTIONS = ['start', 'account', 'review', 'certificate'] as const;
const STEPS = ['account', 'confirm', 'details', 'review'] as const;

/**
 * The public seller sign-up page (handoffs/seller-signup.md). From a 900px page area (1140px with
 * the rail): the heading, benefits and questions on the left, the form card on the right.
 * Narrower: heading, form card, benefits, questions. "How it works" runs full width below. Area
 * and business identifier come from the Market. No commission or fee is stated here (not decided).
 */
export async function SellPage({ setup }: { readonly setup: SellerSignUpSetup }) {
  const t = await getTranslations('sell');
  const identifier = setup.businessIdentifier;
  return (
    <div className="sg">
      <section className="sg-hero" aria-labelledby="sg-title">
        <div className="sg-copy">
          <h1 id="sg-title">{t('heading')}</h1>
          <p>{t('lead', { area: setup.serviceArea })}</p>
        </div>
        <SellerSignUpCard
          passwordMin={setup.passwordMinLength}
          passwordMax={setup.passwordMaxLength}
          signInUrl={setup.sellerSignInUrl}
        />
        <ul className="sg-pts">
          {BENEFITS.map(({ key, icon }) => (
            <li key={key}>
              <span className="ic" aria-hidden="true">
                <Icon name={icon} />
              </span>
              <div>
                <b>{t(`benefits.${key}-title`)}</b>
                <span className="d">{t(`benefits.${key}-body`)}</span>
              </div>
            </li>
          ))}
        </ul>
        <section className="sg-faqs" aria-labelledby="sg-questions">
          <h2 id="sg-questions">{t('questions')}</h2>
          <SellFaq
            items={QUESTIONS.map((key) => ({
              question: t(`faq.${key}-q`),
              answer: t(`faq.${key}-a`, { identifier }),
            }))}
          />
        </section>
      </section>
      <section className="sg-sec" aria-labelledby="sg-how">
        <h2 id="sg-how">{t('how')}</h2>
        <ol className="sg-steps">
          {STEPS.map((key) => (
            <li key={key}>
              <b>{t(`steps.${key}-title`)}</b>
              <span>{t(`steps.${key}-body`, { identifier })}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
