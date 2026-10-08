import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SETUP_ROOT } from '../../src/setup/steps.ts';
import { requireSession } from '../../src/server/session.ts';
import { SellerShell } from '../../src/server/seller-shell.tsx';

export default async function HomePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  // Until the seller is approved the limited shell has one page: the account setup (ID-UX F5).
  if (gate.session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  return (
    <SellerShell session={gate.session} activeId="s_home" title={t('home.title')}>
      <p className="text-fg-muted">{t('home.empty')}</p>
    </SellerShell>
  );
}
