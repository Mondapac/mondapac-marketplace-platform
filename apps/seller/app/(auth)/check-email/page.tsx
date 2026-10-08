import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '../../../src/auth/auth-frame.tsx';
import { CheckEmailPanel } from '../../../src/auth/check-email-panel.tsx';

export async function generateMetadata() {
  const t = await getTranslations('identity.check-email');
  return { title: t('page-title') };
}

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('identity.check-email');
  const { from } = await searchParams;
  return (
    <AuthFrame title={t('title')}>
      <CheckEmailPanel fromSignIn={from === 'sign-in'} />
    </AuthFrame>
  );
}
