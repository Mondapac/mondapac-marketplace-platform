import 'server-only';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { SetupStepKey } from '../setup/steps.ts';
import { StepHeader } from '../setup/step-header.tsx';
import { SellerShell } from './seller-shell.tsx';
import { loadSetupPage, type SetupPage } from './setup-page.ts';

type Loaded = Extract<SetupPage, { kind: 'ok' }>;

/** Shared frame of S2 to S5: loads the data, shows the shell, the step header and the form. */
export async function SetupStepPage({
  step,
  children,
}: {
  readonly step: SetupStepKey;
  readonly children: (page: Loaded) => ReactNode;
}) {
  const page = await loadSetupPage();
  const t = await getTranslations();
  if (page.kind !== 'ok') {
    return <p className="p-6 text-fg-muted">{t('sellers.page.unavailable')}</p>;
  }
  return (
    <SellerShell session={page.session} activeId="s_setup" title={t('nav.setup')}>
      <StepHeader step={step} />
      <div className="max-w-(--mp-size-form-max)">{children(page)}</div>
    </SellerShell>
  );
}
