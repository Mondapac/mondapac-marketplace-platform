import { Banner, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { SETUP_STEPS, type SetupStepKey } from './steps.ts';
import type { MissingPart, MyFile } from './types.ts';

// Which missing parts belong to which step. Until the API sends `onboardingSteps` the hub derives
// each step's state from `missing` (sellers ux 3.1).
const PARTS: Readonly<Record<SetupStepKey, readonly MissingPart[]>> = {
  business: ['storeName', 'businessName', 'phone'],
  address: ['address', 'timezone'],
  number: ['identifier'],
  slug: ['slug'],
};

/** S1: the checklist of the setup steps and what is still to do. */
export function SetupHub({ file }: { readonly file: MyFile }) {
  const t = useTranslations('sellers');
  return (
    <div className="flex max-w-(--mp-size-form-max) flex-col gap-5">
      <p className="text-fg-muted">{t('account.intro')}</p>
      {file.outsideServiceArea === true ? (
        <Banner tone="info">{t('account.outside-area')}</Banner>
      ) : null}
      <Card>
        <ol className="flex flex-col divide-y divide-line">
          {SETUP_STEPS.map((step) => {
            const todo = PARTS[step.key].some((part) => file.missing.includes(part));
            return (
              <li
                key={step.key}
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-col">
                  <span className="font-medium text-fg">{t(`steps.${step.key}`)}</span>
                  <span className={todo ? 'text-sm text-fg-muted' : 'text-sm text-success-fg'}>
                    {t(todo ? 'account.step-todo' : 'account.step-done')}
                  </span>
                </div>
                <Link href={step.href} className="text-sm font-medium text-link hover:underline">
                  {t('account.open')}
                </Link>
              </li>
            );
          })}
          <li className="flex items-center justify-between gap-4 py-3 last:pb-0">
            <div className="flex flex-col">
              <span className="font-medium text-fg">{t('steps.submit')}</span>
              <span className="text-sm text-fg-muted">{t('account.submit-later')}</span>
            </div>
            <span className="text-sm text-fg-muted">{t('account.status-waiting')}</span>
          </li>
        </ol>
      </Card>
    </div>
  );
}
