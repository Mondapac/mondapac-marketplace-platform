import { type Id } from '@mondapac/shared-kernel';
import { derivedId } from './derived-id';

const SOURCE = '0195a1c4-7d2e-7b10-8f3a-5c2d9e4b6a71' as Id<'Seller'>;

describe('derivedId', () => {
  it('is a version 7 id, stable, keeps the time prefix and differs from the source', () => {
    const id = derivedId<'StoreProfile'>('test.ns', SOURCE);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(derivedId('test.ns', SOURCE)).toBe(id);
    expect(id).not.toBe(SOURCE);
    expect(id.slice(0, 13)).toBe(SOURCE.slice(0, 13));
  });

  it('differs by namespace and by source', () => {
    const other = '0195a1c4-7d2e-7b10-8f3a-5c2d9e4b6a72' as Id<'Seller'>;
    const id = derivedId('test.ns', SOURCE);
    expect(derivedId('test.other', SOURCE)).not.toBe(id);
    expect(derivedId('test.ns', other)).not.toBe(id);
  });

  it('refuses a source that is not a version 7 id', () => {
    expect(() => derivedId('test.ns', 'not-an-id' as Id)).toThrow(RangeError);
  });
});
