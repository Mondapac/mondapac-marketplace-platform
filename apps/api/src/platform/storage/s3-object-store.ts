import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  assertObjectKey,
  ObjectAlreadyExistsError,
  ObjectStoreUnavailableError,
  type ObjectStore,
} from './object-store';

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  readonly region: string;
  /** Null: the AWS default credential chain (an instance role). Never logged. */
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | null;
}

/** A start-up check failed: the process must not start (a message names no secret). */
export class ObjectStoreMisconfiguredError extends Error {
  override readonly name = 'ObjectStoreMisconfiguredError';
}

/**
 * The Amazon S3 adapter (file storage pilot F2). Only this file imports the AWS client. A
 * write never replaces an object (`If-None-Match: *`); objects are encrypted at
 * rest (SSE-S3). Every failure but "no such key" answers `ObjectStoreUnavailableError`.
 */
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #region: string;

  constructor(options: S3ObjectStoreOptions, client?: S3Client) {
    this.#bucket = options.bucket;
    this.#region = options.region;
    this.#client =
      client ??
      new S3Client({
        region: options.region,
        maxAttempts: 3,
        ...(options.credentials === null ? {} : { credentials: options.credentials }),
      });
  }

  /**
   * Read-only start-up check: the bucket exists in the configured region and, on Amazon S3,
   * blocks every kind of public access. Throws `ObjectStoreMisconfiguredError`.
   */
  async verify(): Promise<void> {
    try {
      const head = await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
      const actual = head.BucketRegion;
      if (actual !== undefined && actual !== this.#region) {
        throw new ObjectStoreMisconfiguredError(
          `object store bucket is in region ${actual}, not ${this.#region}`,
        );
      }
    } catch (error) {
      if (error instanceof ObjectStoreMisconfiguredError) throw error;
      throw new ObjectStoreMisconfiguredError(
        `object store bucket is not reachable (${describe(error)})`,
      );
    }
    let blocked: boolean;
    try {
      const out = await this.#client.send(
        new GetPublicAccessBlockCommand({ Bucket: this.#bucket }),
      );
      const rules = out.PublicAccessBlockConfiguration;
      blocked =
        rules?.BlockPublicAcls === true &&
        rules.IgnorePublicAcls === true &&
        rules.BlockPublicPolicy === true &&
        rules.RestrictPublicBuckets === true;
    } catch (error) {
      throw new ObjectStoreMisconfiguredError(
        `object store public access block cannot be read (${describe(error)})`,
      );
    }
    if (!blocked) {
      throw new ObjectStoreMisconfiguredError(
        'object store bucket does not block all public access',
      );
    }
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    assertObjectKey(key);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ServerSideEncryption: 'AES256',
          // Writes only when the key is free: S3 answers 412 for an existing object.
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      // 409 is a concurrent write to the same key racing this one: the key is taken either way.
      if (
        error instanceof S3ServiceException &&
        (error.$metadata.httpStatusCode === 412 || error.$metadata.httpStatusCode === 409)
      ) {
        throw new ObjectAlreadyExistsError();
      }
      throw new ObjectStoreUnavailableError();
    }
  }

  async get(key: string): Promise<Buffer | null> {
    assertObjectKey(key);
    try {
      const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (out.Body === undefined) throw new ObjectStoreUnavailableError();
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof S3ServiceException && error.name === 'NoSuchKey') return null;
      throw new ObjectStoreUnavailableError();
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
    } catch {
      throw new ObjectStoreUnavailableError();
    }
  }
}

/** The error's name only: a message can carry a request id or a key, never a secret. */
function describe(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
