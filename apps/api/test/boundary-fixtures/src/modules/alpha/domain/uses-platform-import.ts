import { csvCell } from '@mondapac/platform-import';

// Allowed: domain/ may import the framework-free platform-import package, by its package name.
export function allowed(value: string): string {
  return csvCell(value);
}
