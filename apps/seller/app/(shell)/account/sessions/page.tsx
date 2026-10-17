import { LoadError } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { formatInstant } from '../../../../src/catalog/format.ts';
import { deviceLabel } from '../../../../src/profile/device-label.ts';
import { SessionsCard, type SessionRow } from '../../../../src/profile/sessions-card.tsx';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { readSellerZone } from '../../../../src/server/seller-zone.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';

interface OwnSessions {
  readonly items: readonly {
    readonly device: string | null;
    readonly signedInAt: string;
    readonly lastActiveAt: string;
    readonly current: boolean;
  }[];
}

export async function generateMetadata() {
  const t = await getTranslations('sessions');
  return { title: t('title') };
}

/** Signed-in devices: the member's own live sessions, opened from the account menu. */
export default async function SessionsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  const locale = await getLocale();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('sessions.unavailable')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const [result, zone] = await Promise.all([
    serverGet<OwnSessions>('identity/seller/profile/sessions'),
    readSellerZone(),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const title = t('sessions.title');
  const format = (iso: string) => formatInstant(iso, locale, session.timezone ?? zone);
  const rows: readonly SessionRow[] =
    result.kind === 'ok'
      ? result.body.items.map((item) => ({
          device: deviceLabel(t, item.device),
          signedInAt: item.signedInAt,
          signedInLabel: format(item.signedInAt),
          lastActiveAt: item.lastActiveAt,
          lastActiveLabel: format(item.lastActiveAt),
          current: item.current,
        }))
      : [];
  return (
    <SellerShell session={session} activeId="account" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {result.kind === 'ok' ? (
        <SessionsCard rows={rows} csrfToken={session.csrfToken} />
      ) : (
        <LoadError message={t('sessions.unavailable')} retryLabel={t('load.retry')} />
      )}
    </SellerShell>
  );
}
