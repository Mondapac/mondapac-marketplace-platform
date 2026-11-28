# Admin seller access card screenshots (not part of CI)

Renders the admin `SellerAccessCard` (Suspend and Lift suspension, BUG-023) against a mocked `/api/`
that refuses with `seller-access.wrong-state`: the approved card, the suspend dialog filled in, the
suspend dialog with an empty reason, the refused suspend, the suspended card and the lift dialog, at
375, 768 and 1280 px in light and dark. The panel shell is not drawn. Run from `apps/admin`:

    VITE_PATH=<vite package folder> PLAYWRIGHT_PATH=<playwright package folder> \
      node test/seller-access-card-shots/run.mjs <out-dir>
