'use client';

import { CheckboxRow, LinkButton } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/** Above the types list: New type (for an admin who may edit types) and the closed-proposals filter. */
export function TypesToolbar({
  canEdit,
  closed,
}: {
  readonly canEdit: boolean;
  readonly closed: boolean;
}) {
  const t = useTranslations('certificates.types');
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      {canEdit ? (
        <LinkButton href="/certificates/types/new" className="max-sm:w-full sm:order-last">
          {t('new')}
        </LinkButton>
      ) : null}
      <CheckboxRow
        label={t('show-closed')}
        checked={closed}
        onChange={(event) =>
          window.location.assign(
            event.target.checked ? '/certificates/types?closed=true' : '/certificates/types',
          )
        }
      />
    </div>
  );
}
