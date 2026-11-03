/** A value from the API as a translation key suffix; anything unlisted becomes `unknown`. */
export function known(value: string | null, allowed: readonly string[]): string {
  return value !== null && allowed.includes(value) ? value : 'unknown';
}

/**
 * A service area as a name: the display name the API gives, else the code
 * ("greater-brisbane") made readable ("Greater Brisbane") for an area the configuration no
 * longer names.
 */
export function areaName(code: string | null, name?: string | null): string | null {
  if (name !== undefined && name !== null && name.trim() !== '') return name;
  if (code === null || code.trim() === '') return null;
  return code
    .split(/[-_]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// The shared postal address layout (one for both panels).
export { addressLines } from '@mondapac/ui';
