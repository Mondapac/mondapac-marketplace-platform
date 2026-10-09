import { getTranslations } from 'next-intl/server';

/** Keyset paging: the next page is a link carrying the cursor the API returned. */
export async function Pager({
  basePath,
  nextAfterId,
}: {
  readonly basePath: string;
  readonly nextAfterId: string | null;
}) {
  if (nextAfterId === null) return null;
  const t = await getTranslations();
  return (
    <p className="mt-4">
      <a
        className="font-medium text-link underline"
        href={`${basePath}?after=${encodeURIComponent(nextAfterId)}`}
      >
        {t('catalog.next-page')}
      </a>
    </p>
  );
}
