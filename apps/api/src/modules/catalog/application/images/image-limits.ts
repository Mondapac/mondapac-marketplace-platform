/** Photos a product may hold in its library. */
export const MAX_IMAGES_PER_PRODUCT = 8;
/** The largest upload accepted, in bytes (the photo is shrunk in the browser first). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/**
 * How long a photo may sit in a product's library without a revision holding it before the orphan
 * sweep may remove it, in hours. A draft that names the photo keeps it whatever its age.
 */
export const ORPHAN_IMAGE_GRACE_HOURS = 48;
/** Photos one sweep run looks at per unit, and how many units one run takes at most. */
export const ORPHAN_SWEEP_BATCH = 50;
export const ORPHAN_SWEEP_MAX_BATCHES = 20;
/**
 * The file sweep (files with no row): objects one run lists per page, and how many pages one run
 * reads at most. A run reads at most pages * page objects; it starts from the beginning each time.
 */
export const ORPHAN_FILE_SWEEP_PAGE = 1000;
export const ORPHAN_FILE_SWEEP_MAX_PAGES = 50;
