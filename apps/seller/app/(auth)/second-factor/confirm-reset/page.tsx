import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '../../../../src/auth/auth-frame.tsx';
import { ConfirmResetForm } from '../../../../src/auth/confirm-reset-form.tsx';

export async function generateMetadata() {
  const t = await getTranslations('identity.confirm-reset');
  return { title: t('page-title'), referrer: 'no-referrer' };
}

export default async function ConfirmSecondFactorResetPage() {
  const t = await getTranslations('identity.confirm-reset');
  return (
    <AuthFrame title={t('title')}>
      <ConfirmResetForm />
    </AuthFrame>
  );
}
