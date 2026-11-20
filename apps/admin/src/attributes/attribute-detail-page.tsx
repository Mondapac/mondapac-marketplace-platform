'use client';

import { useTranslations } from 'next-intl';
import { AttributeDetailPanel } from './attribute-detail.tsx';
import { ATTRIBUTES_PATH } from './types.ts';

/** Back to the list: the browser's own Back when the admin came from it, so its filters stay. */
function backToList(event: React.MouseEvent) {
  try {
    if (
      document.referrer !== '' &&
      new URL(document.referrer).pathname === ATTRIBUTES_PATH &&
      window.history.length > 1
    ) {
      event.preventDefault();
      window.history.back();
    }
  } catch {
    // The link itself goes to the list.
  }
}

/**
 * One attribute on its own page (super list phase 2, list 5): the details, values, uses and
 * history the panel shows, with Back to the list above. A request that is already open is on the
 * Waiting for you tab.
 */
export function AttributeDetailPage({
  attributeId,
  canEdit,
  canRestructure,
  csrfToken,
}: {
  readonly attributeId: string;
  readonly canEdit: boolean;
  readonly canRestructure: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('attributes');
  return (
    <div className="mt-1 flex flex-col gap-4">
      <p>
        <a className="font-medium text-link underline" href={ATTRIBUTES_PATH} onClick={backToList}>
          {t('detail-page.back')}
        </a>
      </p>
      <AttributeDetailPanel
        attributeId={attributeId}
        onClose={() => window.location.assign(ATTRIBUTES_PATH)}
        canEdit={canEdit}
        canRestructure={canRestructure}
        csrfToken={csrfToken}
        onOpenWaiting={() => window.location.assign(`${ATTRIBUTES_PATH}?tab=waiting`)}
      />
    </div>
  );
}
