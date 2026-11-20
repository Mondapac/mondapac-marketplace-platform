# Blog posts list screenshots (not part of CI)

Renders the real `PostsList` (super list 26) against a stub API with fixture posts at 1280, 768 and
375 px in light and dark, plus the filter panel, the row Actions menu, the sort and column panels,
the Bulk action menu, the Export dialog, and the empty-view and no-match states. Run from
`apps/admin`:

    VITE_PATH=<vite package folder> node test/blog-posts-shots/run.mjs <out-dir>
