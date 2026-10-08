import { AuthLayout } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { panelConfig } from '../server/config.ts';

/** The seller Auth template with the Market's name and support address (identity ux 3.1). */
export async function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  const t = await getTranslations();
  const config = panelConfig();
  return (
    <AuthLayout
      panel="seller"
      badge={t('identity.common.account-type.seller')}
      title={title}
      marketName={t('panel.market', { marketName: config.marketName })}
      supportLine={t('panel.support', { supportEmail: config.supportEmail })}
      showcaseTitle={t('showcase.title')}
      showcaseCards={(['one', 'two', 'three'] as const).map((key) => ({
        name: t(`showcase.cards.${key}.name`),
        detail: t(`showcase.cards.${key}.detail`),
      }))}
    >
      {children}
    </AuthLayout>
  );
}
