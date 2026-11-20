'use client';

import { Menu } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

/**
 * The row menu of a page. Opening the editor is its only action (confirmation level 1); publish,
 * archive and the rest live in the editor, where the page's draft and versions are in view.
 */
export function PageRowActions({ href, title }: { readonly href: string; readonly title: string }) {
  const t = useTranslations('content.pages.list');
  const router = useRouter();
  return (
    <Menu
      label={t('actions-for', { name: title })}
      items={[{ id: 'open', label: t('open-page'), onSelect: () => router.push(href) }]}
    />
  );
}
