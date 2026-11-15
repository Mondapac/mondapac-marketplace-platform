'use client';

import { Button } from '@mondapac/ui';

/** Opens the browser's print dialog for the page (the order document). */
export function PrintButton({ label }: { readonly label: string }) {
  return (
    <Button variant="secondary" className="print:hidden" onClick={() => window.print()}>
      {label}
    </Button>
  );
}
