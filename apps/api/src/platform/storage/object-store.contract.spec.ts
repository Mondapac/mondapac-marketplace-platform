import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { DiskObjectStore } from './disk-object-store';
import { MemoryObjectStore } from './disk-object-store';
import { ObjectStoreUnavailableError, type ObjectStore } from './object-store';
import { S3ObjectStore } from './s3-object-store';

/** One contract, every adapter: what a caller may rely on behind the port. */
interface Harness {
  readonly store: ObjectStore;
  readonly cleanup?: () => Promise<void>;
}

const adapters: Record<string, () => Promise<Harness>> = {
  memory: () => Promise.resolve({ store: new MemoryObjectStore() }),
  disk: async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'contract-'));
    return {
      store: new DiskObjectStore(dir),
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  },
  's3 (SDK client replaced by a stateful fake)': () => {
    const objects = new Map<string, Buffer>();
    const mock = mockClient(S3Client);
    mock.on(PutObjectCommand).callsFake((input: { Key: string; Body: Buffer }) => {
      objects.set(input.Key, Buffer.from(input.Body));
      return {};
    });
    mock.on(GetObjectCommand).callsFake((input: { Key: string }) => {
      const found = objects.get(input.Key);
      if (found === undefined) {
        throw new S3ServiceException({
          name: 'NoSuchKey',
          $fault: 'client',
          $metadata: {},
        });
      }
      return { Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(found)) } };
    });
    mock.on(DeleteObjectCommand).callsFake((input: { Key: string }) => {
      objects.delete(input.Key);
      return {};
    });
    return Promise.resolve({
      store: new S3ObjectStore(
        { bucket: 'b', region: 'ap-southeast-2', endpoint: null, credentials: null },
        new S3Client({ region: 'ap-southeast-2' }),
      ),
      cleanup: () => {
        mock.restore();
        return Promise.resolve();
      },
    });
  },
};

describe.each(Object.entries(adapters))('ObjectStore contract: %s', (_name, make) => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await make();
  });
  afterEach(async () => {
    await harness.cleanup?.();
  });

  it('returns what was written', async () => {
    await harness.store.put('p1/i1/thumb', Buffer.from([0, 1, 2, 255]));
    expect(await harness.store.get('p1/i1/thumb')).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it('answers null for a missing key', async () => {
    expect(await harness.store.get('p1/none')).toBeNull();
  });

  it('replaces an object written twice', async () => {
    await harness.store.put('p1/i1', Buffer.from('one'));
    await harness.store.put('p1/i1', Buffer.from('two'));
    expect((await harness.store.get('p1/i1'))?.toString()).toBe('two');
  });

  it('deletes, and deleting a missing key is not an error', async () => {
    await harness.store.put('p1/i1', Buffer.from('x'));
    await harness.store.delete('p1/i1');
    expect(await harness.store.get('p1/i1')).toBeNull();
    await expect(harness.store.delete('p1/i1')).resolves.toBeUndefined();
  });

  it('refuses a key that could leave the root', async () => {
    await expect(harness.store.get('../etc/passwd')).rejects.toThrow('invalid object key');
    await expect(harness.store.put('a/../x', Buffer.from('x'))).rejects.toThrow(
      'invalid object key',
    );
    await expect(harness.store.delete('a//b')).rejects.toThrow('invalid object key');
  });
});

describe('S3ObjectStore failures', () => {
  it('answers unavailable when S3 fails, and never leaks the cause', async () => {
    const mock = mockClient(S3Client);
    mock.on(GetObjectCommand).rejects(new Error('AccessDenied for key AKIASECRET'));
    mock.on(PutObjectCommand).rejects(new Error('boom'));
    mock.on(DeleteObjectCommand).rejects(new Error('boom'));
    const store = new S3ObjectStore(
      { bucket: 'b', region: 'ap-southeast-2', endpoint: null, credentials: null },
      new S3Client({ region: 'ap-southeast-2' }),
    );
    await expect(store.get('a')).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
    await expect(store.get('a')).rejects.not.toThrow(/AKIA/);
    await expect(store.put('a', Buffer.from('x'))).rejects.toBeInstanceOf(
      ObjectStoreUnavailableError,
    );
    await expect(store.delete('a')).rejects.toBeInstanceOf(ObjectStoreUnavailableError);
    mock.restore();
  });
});
