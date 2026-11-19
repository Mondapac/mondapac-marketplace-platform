# Seller page ledger and payout holds screenshots (not part of CI)

Renders the real `LedgerCard` (super list 27) and `PayoutHoldsCard` (super list 28) stacked, as on
the admin seller page, against a stub API with fixture rows at 1280, 768 and 375 px in light and
dark, plus the filter panels, the row Actions menus, the Place hold… and Release hold… dialogs
(empty and typed) and the empty and no-match states. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/ledger-holds-shots/run.mjs <out-dir>
