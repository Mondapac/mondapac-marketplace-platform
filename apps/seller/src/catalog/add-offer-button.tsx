'use client';

import { Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AddOfferDialog } from './add-offer-dialog.tsx';

/** The "Add offer" button of the Products and Offers headers, and the search it opens. */
export function AddOfferButton({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('catalog.addOffer');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('button')}
      </Button>
      {open ? (
        <AddOfferDialog
          open
          csrfToken={csrfToken}
          onClose={() => setOpen(false)}
          navigate={(path) => {
            setOpen(false);
            router.push(path);
          }}
        />
      ) : null}
    </>
  );
}
