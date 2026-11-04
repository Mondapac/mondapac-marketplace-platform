import {
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { ObjectStoreMisconfiguredError, S3ObjectStore } from './s3-object-store';

const REGION = 'ap-southeast-2';
const make = () =>
  new S3ObjectStore(
    { bucket: 'b', region: REGION, credentials: null },
    new S3Client({ region: REGION }),
  );
const allBlocked = {
  PublicAccessBlockConfiguration: {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true,
  },
};

describe('S3ObjectStore.verify', () => {
  const mock = mockClient(S3Client);
  beforeEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('passes for a private bucket in the right region', async () => {
    mock.on(HeadBucketCommand).resolves({ BucketRegion: REGION });
    mock.on(GetPublicAccessBlockCommand).resolves(allBlocked);
    await expect(make().verify()).resolves.toBeUndefined();
  });

  it('refuses a missing or unreachable bucket', async () => {
    mock.on(HeadBucketCommand).rejects(Object.assign(new Error('x'), { name: 'NotFound' }));
    await expect(make().verify()).rejects.toThrow(ObjectStoreMisconfiguredError);
  });

  it('refuses a bucket in another region', async () => {
    mock.on(HeadBucketCommand).resolves({ BucketRegion: 'us-east-1' });
    await expect(make().verify()).rejects.toThrow('us-east-1');
  });

  it('refuses a bucket that does not block all public access', async () => {
    mock.on(HeadBucketCommand).resolves({ BucketRegion: REGION });
    mock
      .on(GetPublicAccessBlockCommand)
      .resolves({ PublicAccessBlockConfiguration: { BlockPublicAcls: true } });
    await expect(make().verify()).rejects.toThrow('does not block all public access');
  });

  it('refuses when the public access block cannot be read', async () => {
    mock.on(HeadBucketCommand).resolves({ BucketRegion: REGION });
    mock
      .on(GetPublicAccessBlockCommand)
      .rejects(Object.assign(new Error('x'), { name: 'AccessDenied' }));
    await expect(make().verify()).rejects.toThrow('cannot be read');
  });
});

describe('S3ObjectStore.put', () => {
  it('asks for encryption at rest', async () => {
    const mock = mockClient(S3Client);
    mock.on(PutObjectCommand).resolves({});
    await make().put('a', Buffer.from('x'));
    expect(mock.commandCalls(PutObjectCommand)[0]?.args[0].input.ServerSideEncryption).toBe(
      'AES256',
    );
    mock.restore();
  });
});
