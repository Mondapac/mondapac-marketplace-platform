import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '../../../src/auth/auth-frame.tsx';
import { ConfirmEmailForm } from '../../../src/auth/confirm-email-form.tsx';

export async function generateMetadata() {
  const t = await getTranslations('identity.confirm-email');
  return { title: t('page-title'), referrer: 'no-referrer' };
}

export default async function ConfirmEmailPage() {
  const t = await getTranslations('identity.confirm-email');
  return (
    <AuthFrame title={t('title')}>
      <ConfirmEmailForm />
    </AuthFrame>
  );
}
