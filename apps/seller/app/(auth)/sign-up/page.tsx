import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '../../../src/auth/auth-frame.tsx';
import { SignUpForm } from '../../../src/auth/sign-up-form.tsx';
import { panelConfig } from '../../../src/server/config.ts';

export async function generateMetadata() {
  const t = await getTranslations('identity.sign-up');
  return { title: t('page-title') };
}

export default async function SignUpPage() {
  const t = await getTranslations('identity.sign-up');
  const config = panelConfig();
  return (
    <AuthFrame title={t('title')}>
      <SignUpForm passwordMin={config.passwordMinLength} passwordMax={config.passwordMaxLength} />
    </AuthFrame>
  );
}
