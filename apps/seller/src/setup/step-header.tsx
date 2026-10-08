import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { SETUP_ROOT, SETUP_STEPS, stepNumber, type SetupStepKey } from './steps.ts';

/** Back link, step counter and the page title of S2 to S5 (sellers ux 3.1). */
export function StepHeader({ step }: { readonly step: SetupStepKey }) {
  const t = useTranslations('sellers');
  return (
    <header className="mb-6 flex max-w-(--mp-size-form-max) flex-col gap-2">
      <Link href={SETUP_ROOT} className="text-sm font-medium text-link hover:underline">
        {t('step.back')}
      </Link>
      <p className="text-sm text-fg-muted">
        {t('step.counter', { current: stepNumber(step), total: SETUP_STEPS.length })}
      </p>
      <h1 className="text-2xl font-semibold text-fg">{t(`steps.${step}`)}</h1>
    </header>
  );
}
