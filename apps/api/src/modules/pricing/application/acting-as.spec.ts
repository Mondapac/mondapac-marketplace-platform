import type { ActorContext } from '@mondapac/shared-kernel';
import { isActingAsSession } from './acting-as';

// The acting-as marker read by the Cost use cases (pricing design 5.4; Hassan finding 6).

describe('isActingAsSession', () => {
  const seller = { kind: 'authenticated', population: 'seller' } as unknown as ActorContext;

  it('is false without the reserved field, or when it is null or undefined', () => {
    expect(isActingAsSession(seller)).toBe(false);
    expect(isActingAsSession({ ...seller, actingAs: null } as unknown as ActorContext)).toBe(false);
    expect(isActingAsSession({ ...seller, actingAs: undefined } as unknown as ActorContext)).toBe(
      false,
    );
  });

  it('is true for any present marker (fail closed: the shape is not checked)', () => {
    for (const actingAs of [{ adminAccountId: 'a' }, {}, 'x', 0, false]) {
      expect(isActingAsSession({ ...seller, actingAs } as unknown as ActorContext)).toBe(true);
    }
  });

  it('ignores an inherited marker (own property only)', () => {
    const inherited = Object.create({ actingAs: { adminAccountId: 'a' } }) as ActorContext;
    expect(isActingAsSession(inherited)).toBe(false);
  });
});
