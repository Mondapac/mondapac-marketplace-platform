// Keyboard movement through the palette's results (WAI-ARIA combobox with a listbox popup).

export type ListKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * The next active option index. Arrow keys wrap around the ends; Home and End jump to them. With
 * no results there is no active option (-1).
 */
export function moveActive(current: number, count: number, key: ListKey): number {
  if (count <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (current < 0) return key === 'ArrowDown' ? 0 : count - 1;
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count;
}

export function isListKey(key: string): key is ListKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}
