# Credit requests list screenshots (not part of CI)

Renders the real `CreditRequestsList` (super list 24) against a stub API with fixture requests at
1280, 768 and 375 px in light and dark, plus the filter panel, the row Actions menu and the
Details, Approve (empty and typed) and Reject dialogs. Run from `apps/admin`:

    VITE_PATH=<vite package folder> node test/credit-requests-shots/run.mjs <out-dir>
