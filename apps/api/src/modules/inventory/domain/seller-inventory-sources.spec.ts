import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { SellerInventory } from './seller-inventory';

const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));

function fresh() {
  const ids = new SequenceIdGenerator(clock);
  const created = SellerInventory.createWithDefaultSource({
    id: ids.next<'SellerInventory'>(),
    defaultSourceId: ids.next<'InventorySource'>(),
    sellerId: ids.next<'Seller'>(),
    marketId: 'AU' as never,
    now: clock.now(),
  });
  // A stored copy: same state, persisted at its version.
  return { ids, inventory: SellerInventory.fromStored(created.state) };
}

const add = (
  t: ReturnType<typeof fresh>,
  inventory: SellerInventory,
  name: string,
  maxSources = 4,
) =>
  inventory.addSource({
    id: t.ids.next<'InventorySource'>(),
    name,
    address: null,
    timeZone: null,
    maxSources,
    now: clock.now(),
  });

describe('SellerInventory sources', () => {
  it('appends a source last, raises the version by one and records the change', () => {
    const t = fresh();
    const added = add(t, t.inventory, 'Garage');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const state = added.value.state;
    expect(state.version).toBe(2);
    expect(state.sources.map((s) => [s.name, s.priority, s.isDefault])).toEqual([
      ['Default', 1, true],
      ['Garage', 2, false],
    ]);
    expect(added.value.persistedVersion).toBe(1);
    expect(added.value.changes).toEqual([{ kind: 'added', sourceId: state.sources[1]!.id }]);
    // The loaded aggregate is untouched.
    expect(t.inventory.state.sources).toHaveLength(1);
  });

  it('refuses a source beyond the Market limit, the Default included', () => {
    const t = fresh();
    expect(add(t, t.inventory, 'Only', 1)).toEqual({
      ok: false,
      error: { code: 'inventory.sources.limit-reached', max: 1 },
    });
    let inventory = t.inventory;
    for (const name of ['A', 'B', 'C']) {
      const next = add(t, inventory, name);
      if (!next.ok) throw new Error('unexpected');
      inventory = next.value;
    }
    expect(inventory.state.sources).toHaveLength(4);
    expect(add(t, inventory, 'E')).toEqual({
      ok: false,
      error: { code: 'inventory.sources.limit-reached', max: 4 },
    });
  });

  it('edits name, address and zone; the Default may be renamed and stays the Default', () => {
    const t = fresh();
    const defaultId = t.inventory.state.sources[0]!.id;
    const edited = t.inventory.editSource({
      sourceId: defaultId,
      name: 'Main shed',
      address: { line1: '1 Test St' },
      timeZone: 'Australia/Brisbane',
    });
    if (!edited.ok) throw new Error('unexpected');
    expect(edited.value.state.sources[0]).toMatchObject({
      name: 'Main shed',
      isDefault: true,
      priority: 1,
      address: { line1: '1 Test St' },
      timeZone: 'Australia/Brisbane',
    });
    expect(edited.value.state.version).toBe(2);
    expect(edited.value.changes).toEqual([{ kind: 'edited', sourceId: defaultId }]);
  });

  it('treats an edit that changes nothing as no change: same aggregate, same version', () => {
    const t = fresh();
    const source = t.inventory.state.sources[0]!;
    const same = t.inventory.editSource({
      sourceId: source.id,
      name: source.name,
      address: null,
      timeZone: null,
    });
    expect(same.ok && same.value).toBe(t.inventory);
  });

  it('answers not-found for a source the inventory does not hold', () => {
    const t = fresh();
    expect(
      t.inventory.editSource({
        sourceId: t.ids.next<'InventorySource'>(),
        name: 'x',
        address: null,
        timeZone: null,
      }),
    ).toEqual({ ok: false, error: { code: 'inventory.source.not-found' } });
  });

  it('reorders to positions 1..n in the given order', () => {
    const t = fresh();
    let inventory = t.inventory;
    for (const name of ['A', 'B']) {
      const next = add(t, inventory, name);
      if (!next.ok) throw new Error('unexpected');
      inventory = next.value;
    }
    const [d, a, b] = inventory.state.sources.map((s) => s.id);
    const reordered = inventory.reorder([b!, d!, a!]);
    if (!reordered.ok) throw new Error('unexpected');
    expect(reordered.value.state.sources.map((s) => [s.name, s.priority])).toEqual([
      ['B', 1],
      ['Default', 2],
      ['A', 3],
    ]);
    expect(reordered.value.state.version).toBe(inventory.state.version + 1);
    expect(reordered.value.changes.at(-1)).toEqual({ kind: 'reordered' });
  });

  it('treats the same order as no change', () => {
    const t = fresh();
    const ids = t.inventory.state.sources.map((s) => s.id);
    const same = t.inventory.reorder(ids);
    expect(same.ok && same.value).toBe(t.inventory);
  });

  it.each([
    ['too few', (ids: Id<'InventorySource'>[]) => ids.slice(1)],
    ['a duplicate', (ids: Id<'InventorySource'>[]) => [ids[0]!, ids[0]!]],
    [
      'a stranger',
      (_ids: Id<'InventorySource'>[]) => [
        '00000000-0000-7000-8000-000000000999' as Id<'InventorySource'>,
        _ids[0]!,
      ],
    ],
  ])('refuses an order with %s', (_label, make) => {
    const t = fresh();
    const withTwo = add(t, t.inventory, 'A');
    if (!withTwo.ok) throw new Error('unexpected');
    const ids = withTwo.value.state.sources.map((s) => s.id);
    expect(withTwo.value.reorder(make(ids))).toEqual({
      ok: false,
      error: { code: 'inventory.sources.order-mismatch' },
    });
  });
});
