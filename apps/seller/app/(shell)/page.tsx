import { LoadError, ShortcutGrid, visibleNavItems } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { sellerNav } from '../../src/nav.ts';
import { SETUP_ROOT } from '../../src/setup/steps.ts';
import { requireSession } from '../../src/server/session.ts';
import { SellerShell } from '../../src/server/seller-shell.tsx';

export default async function HomePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  // Until the seller is approved the limited shell has one page: the account setup (ID-UX F5).
  if (gate.session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  return (
    <SellerShell session={gate.session} activeId="s_home" title={t('home.title')}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="break-words text-2xl font-semibold">
            {t('home.welcome', { name: gate.session.displayName })}
          </h1>
          <p className="text-fg-muted">{t('home.intro')}</p>
        </div>
        {/* The sections this person may open, as in the menu; Home and setup are left out. */}
        <ShortcutGrid
          label={t('home.shortcuts')}
          items={visibleNavItems(sellerNav, new Set(gate.session.permissionKeys))
            .filter((item) => item.id !== 's_home' && item.id !== 's_setup')
            .map((item) => {
              const key = item.labelKey.replace(/^nav\./, '');
              return {
                id: item.id,
                href: item.href,
                icon: item.icon,
                title: t(item.labelKey),
                body: t(`home.shortcut.${key}`),
              };
            })}
        />
      </div>
    </SellerShell>
  );
}
