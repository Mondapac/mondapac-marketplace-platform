import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  SecurityFrame,
  SecurityNoAccess,
  SecurityUnavailable,
} from '../../../../src/security-centre/frame.tsx';
import { OnCallView } from '../../../../src/security-centre/on-call-view.tsx';
import { VIEW_PERMISSION, type OnCall } from '../../../../src/security-centre/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('security-centre.title') };
}

/** Security > On call (design v3, screen 4): read-only, names only. */
export default async function SecurityOnCallPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <SecurityFrame session={session} tab={null}>
        <SecurityNoAccess />
      </SecurityFrame>
    );
  }
  const answer = await serverGet<OnCall>('security/admin/on-call');
  if (answer.kind === 'signed-out') redirect('/session-ended');
  return (
    <SecurityFrame session={session} tab="on-call">
      {answer.kind === 'ok' ? (
        <OnCallView
          onCall={answer.body}
          locale={await getLocale()}
          now={new Date().toISOString()}
        />
      ) : answer.kind === 'forbidden' ? (
        <SecurityNoAccess />
      ) : (
        <SecurityUnavailable message={t('security-centre.error.on-call-title')} />
      )}
    </SecurityFrame>
  );
}
