import { EventEmitter } from 'node:events';

import { writeChunks } from './write-chunks';

/** A response double: `write` answers false (a full buffer) for the chunks named in `fullAfter`. */
class FakeResponse extends EventEmitter {
  destroyed = false;
  readonly written: string[] = [];
  ended = false;
  constructor(private readonly fullOn: ReadonlySet<string> = new Set()) {
    super();
  }
  write(chunk: string): boolean {
    this.written.push(chunk);
    return !this.fullOn.has(chunk);
  }
  end(): void {
    this.ended = true;
  }
}

const asResponse = (r: FakeResponse): Parameters<typeof writeChunks>[0] =>
  r as unknown as Parameters<typeof writeChunks>[0];

describe('writeChunks (export streaming, Hassan L-583-2)', () => {
  it('writes every chunk, waits for a drain, and ends the response', async () => {
    const response = new FakeResponse(new Set(['b']));
    const run = writeChunks(
      asResponse(response),
      (async function* () {
        await Promise.resolve();
        yield 'a';
        yield 'b';
        yield 'c';
      })(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // Stopped at the full buffer: 'c' waits for the drain.
    expect(response.written).toEqual(['a', 'b']);
    response.emit('drain');
    await expect(run).resolves.toBe(true);
    expect(response.written).toEqual(['a', 'b', 'c']);
    expect(response.ended).toBe(true);
  });

  it('stops waiting when the client disconnects while the buffer is full, and closes the source', async () => {
    const response = new FakeResponse(new Set(['a']));
    let sourceClosed = false;
    let pulled = 0;
    const run = writeChunks(
      asResponse(response),
      (async function* () {
        await Promise.resolve();
        try {
          for (;;) {
            pulled += 1;
            yield 'a';
          }
        } finally {
          sourceClosed = true;
        }
      })(),
    );
    await new Promise((resolve) => setImmediate(resolve));
    response.emit('close');
    await expect(run).resolves.toBe(false);
    expect(response.ended).toBe(false);
    expect(sourceClosed).toBe(true);
    expect(pulled).toBeLessThanOrEqual(2);
  });

  it('writes nothing when the client is already gone', async () => {
    const response = new FakeResponse();
    response.destroyed = true;
    await expect(
      writeChunks(
        asResponse(response),
        (async function* () {
          await Promise.resolve();
          yield 'a';
        })(),
      ),
    ).resolves.toBe(false);
    expect(response.written).toEqual([]);
  });

  it('leaves no listener behind', async () => {
    const response = new FakeResponse();
    await writeChunks(
      asResponse(response),
      (async function* () {
        await Promise.resolve();
        yield 'a';
      })(),
    );
    expect(response.listenerCount('close')).toBe(0);
  });
});
