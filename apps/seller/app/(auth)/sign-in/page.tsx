import { getTranslations } from 'next-intl/server';
import { AuthFrame } from '../../../src/auth/auth-frame.tsx';
import { SignInForm, type SignInNotice } from '../../../src/auth/sign-in-form.tsx';

const NOTICES: readonly SignInNotice[] = ['session-ended', 'signed-out', 'password-changed'];

export async function generateMetadata() {
  const t = await getTranslations('identity.sign-in');
  return { title: t('page-title') };
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations('identity.sign-in');
  const { notice } = await searchParams;
  const shown = NOTICES.find((candidate) => candidate === notice) ?? null;
  return (
    <AuthFrame title={t('title')}>
      <SignInForm notice={shown} />
    </AuthFrame>
  );
}
