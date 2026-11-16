// Saved filters of the Invoices list (spec 0.11). They need a list key from PR #918 (a registry
// that does not exist on this branch yet: `admin.ordering.documents`), so the saved-filter UI is
// hidden for now: no saved tabs, no "Manage filters", no "Save filter". The list reads this one
// seam; once the key exists, this returns the answer of the saved-filters route and the page only
// has to open a saved tab with its payload and show the Save filter button.

/** One saved tab: its name and the rows it matched when last counted. */
export interface SavedInvoiceTab {
  readonly id: string;
  readonly name: string;
  readonly count: number | null;
}

export interface SavedInvoices {
  readonly items: readonly SavedInvoiceTab[];
}

/** The saved filters of this admin; null while they are not available. */
export function savedInvoices(): SavedInvoices | null {
  return null;
}
