import { MemoryObjectStore } from './disk-object-store';
import { isComplete, migrateObjects } from './migrate-object-store';

const seed = async (): Promise<MemoryObjectStore> => {
  const store = new MemoryObjectStore();
  await store.put('p1/a', Buffer.from('one'));
  await store.put('p1/b', Buffer.from('two'));
  return store;
};

describe('migrateObjects', () => {
  it('copies every object and reports matching digests', async () => {
    const source = await seed();
    const target = new MemoryObjectStore();
    const report = await migrateObjects(['p1/a', 'p1/b'], source, target);
    expect(report.copied).toEqual(['p1/a', 'p1/b']);
    expect(isComplete(report)).toBe(true);
    expect((await target.get('p1/b'))?.toString()).toBe('two');
    expect(source.objects.size).toBe(2);
  });

  it('is safe to run again', async () => {
    const source = await seed();
    const target = new MemoryObjectStore();
    await migrateObjects(['p1/a', 'p1/b'], source, target);
    const again = await migrateObjects(['p1/a', 'p1/b'], source, target);
    expect(again.copied).toEqual([]);
    expect(again.identical).toEqual(['p1/a', 'p1/b']);
    expect(isComplete(again)).toBe(true);
  });

  it('never overwrites a different object in the target', async () => {
    const source = await seed();
    const target = new MemoryObjectStore();
    await target.put('p1/a', Buffer.from('other'));
    const report = await migrateObjects(['p1/a', 'p1/b'], source, target);
    expect(report.conflicts).toEqual(['p1/a']);
    expect((await target.get('p1/a'))?.toString()).toBe('other');
    expect(isComplete(report)).toBe(false);
  });

  it('reports a key the source no longer holds', async () => {
    const report = await migrateObjects(
      ['p1/gone'],
      new MemoryObjectStore(),
      new MemoryObjectStore(),
    );
    expect(report.failed).toEqual(['p1/gone']);
    expect(isComplete(report)).toBe(false);
  });
});
