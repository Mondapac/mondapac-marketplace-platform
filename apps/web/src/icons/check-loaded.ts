/**
 * Ref callback for a photo: an image that already failed before React attached `onError` (the
 * server-rendered page was hydrated after the request had failed) is `complete` with no pixels.
 * Calls `onBroken` for it; a photo still loading, or loaded, is left alone.
 */
export function checkLoaded(element: HTMLImageElement | null, onBroken: () => void): void {
  if (
    element !== null &&
    element.complete &&
    element.naturalWidth === 0 &&
    element.currentSrc !== ''
  ) {
    onBroken();
  }
}
