import { Temporal } from '@mondapac/shared-kernel';
import { readChunks } from './review-queue-list.use-case';

type Row = { id: string; at: number };
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, at: i }));
const positionOf = (row: Row) => ({
  submittedAt: Temporal.Instant.fromEpochMilliseconds(row.at),
  id: row.id,
});

describe('readChunks', () => {
  it('reads past the 100-row clamp of a source by walking its keyset', async () => {
    const all = rows(250);
    const takes: number[] = [];
    const read = (
      after: { submittedAt: Temporal.Instant; id: string } | null,
      take: number,
    ): Promise<Row[]> => {
      const capped = Math.min(take, 100);
      takes.push(take);
      const from = after === null ? 0 : all.findIndex((r) => r.id === after.id) + 1;
      return Promise.resolve(all.slice(from, from + capped));
    };
    const got = await readChunks(read, positionOf, null, 230);
    expect(got.map((r) => r.id)).toEqual(all.slice(0, 230).map((r) => r.id));
    expect(takes).toEqual([100, 100, 30]);
  });

  it('stops when the source runs out and starts after a given position', async () => {
    const all = rows(40);
    const read = (
      after: { submittedAt: Temporal.Instant; id: string } | null,
      take: number,
    ): Promise<Row[]> => {
      const from = after === null ? 0 : all.findIndex((r) => r.id === after.id) + 1;
      return Promise.resolve(all.slice(from, from + take));
    };
    expect(await readChunks(read, positionOf, null, 500)).toHaveLength(40);
    const tail = await readChunks(read, positionOf, positionOf(all[9]!), 500);
    expect(tail.map((r) => r.id)[0]).toBe('r10');
    expect(await readChunks(read, positionOf, null, 0)).toEqual([]);
  });
});
