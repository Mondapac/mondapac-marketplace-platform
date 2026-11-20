# payments: implementation notes

## Saved filters (super list phase 4, PR10)

The admin Seller accounts list (`admin.payments.connected-accounts`, key
`payments.connected-account.view`) has saved filters through `lists`
(`application/saved-filters/list-definitions.ts`). It has no views: `status` is a filter, and `q`
is saved as a seller id or a store-name search, as the list reads it. Sharing one needs the new
unprotected key `payments.saved-filter.share`; no role is seeded with it. See
docs/modules/lists/notes.md.
