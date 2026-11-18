/**
 * Where a floating panel (a popover, a menu) is rendered: the modal `<dialog>` its trigger sits in,
 * else the body. A modal dialog makes the rest of the page inert, so a panel portalled to the body
 * from inside one (a list's filter panel in a side panel) could not be clicked or focused.
 */
export function portalHostOf(trigger: HTMLElement | null): HTMLElement {
  return trigger?.closest('dialog') ?? document.body;
}
