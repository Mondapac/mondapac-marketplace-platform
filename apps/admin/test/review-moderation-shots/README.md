# Review moderation list screenshots (not part of CI)

Renders the whole `ModerationList` (list 18) against fixture API answers served by `run.mjs`, at
1280, 768 and 375 px in light and dark, plus the row Actions menu open and the Remove dialog. Run
from `apps/admin`:

    VITE_PATH=<vite package folder> node test/review-moderation-shots/run.mjs <out-dir>
