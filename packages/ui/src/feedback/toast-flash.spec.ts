import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOAST_FLASH_KEY,
  consumeFlash,
  createToastStore,
  flashToast,
  toast,
} from './toast-store.ts';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
}

describe('flash toast', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the outcome until the next page consumes it, once', () => {
    const store = createToastStore();
    toast.flash('success', 'Role created');
    expect(storage.getItem(TOAST_FLASH_KEY)).toContain('Role created');
    expect(store.getSnapshot().visible).toEqual([]);

    expect(consumeFlash(store)).toBe('flash');
    const [shown] = store.getSnapshot().visible;
    expect(shown).toMatchObject({ type: 'success', text: 'Role created' });
    expect(storage.getItem(TOAST_FLASH_KEY)).toBeNull();

    store.dismiss();
    expect(consumeFlash(store)).toBeNull();
    expect(store.getSnapshot().visible).toEqual([]);
  });

  it('keeps the type, the title and the description', () => {
    const store = createToastStore();
    flashToast('error', 'Try again', { title: 'Not saved', description: 'Offline' });
    consumeFlash(store);
    expect(store.getSnapshot().visible[0]).toMatchObject({
      type: 'error',
      text: 'Try again',
      title: 'Not saved',
      description: 'Offline',
    });
  });

  it('lets the last flash win', () => {
    const store = createToastStore();
    flashToast('success', 'First');
    flashToast('success', 'Second');
    consumeFlash(store);
    expect(store.getSnapshot().visible.map((view) => view.text)).toEqual(['Second']);
  });

  it.each([
    'not json',
    '{"type":"loading","text":"x"}',
    '{"type":"success"}',
    '{"type":"success","text":""}',
  ])('drops and clears a flash that is not valid: %s', (raw) => {
    const store = createToastStore();
    storage.setItem(TOAST_FLASH_KEY, raw);
    expect(consumeFlash(store)).toBeNull();
    expect(store.getSnapshot().visible).toEqual([]);
    expect(storage.getItem(TOAST_FLASH_KEY)).toBeNull();
  });

  it('does nothing when sessionStorage is missing or throws', () => {
    const store = createToastStore();
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => flashToast('success', 'Saved')).not.toThrow();
    expect(consumeFlash(store)).toBeNull();

    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('sessionStorage', blocked);
    expect(() => flashToast('success', 'Saved')).not.toThrow();
    expect(consumeFlash(store)).toBeNull();
  });
});
