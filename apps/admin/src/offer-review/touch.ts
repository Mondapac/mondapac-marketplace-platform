// A switch is 44 by 24 px; on a phone its touch area grows to 44 px high without moving anything
// (an invisible layer around it, as the kit's icon Popover does).
export const TOUCH_SWITCH =
  "relative before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-[''] md:before:hidden";
