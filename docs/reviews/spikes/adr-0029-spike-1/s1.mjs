/* eslint-disable -- spike script (evidence), see ../README.md */
import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, GetBucketVersioningCommand, PutBucketLifecycleConfigurationCommand,
  GetBucketLifecycleConfigurationCommand, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand,
  PutObjectRetentionCommand, GetObjectRetentionCommand, CreateMultipartUploadCommand, UploadPartCommand, ListMultipartUploadsCommand,
  PutBucketPolicyCommand, PutPublicAccessBlockCommand, GetObjectLockConfigurationCommand, PutObjectLockConfigurationCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
const mk = (k, s) => new S3Client({ endpoint: 'http://127.0.0.1:8333', region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: k, secretAccessKey: s }, maxAttempts: 1 });
const prov = mk('provkey', 'provsecret'), api = mk('apikey', 'apisecret'), origin = mk('originkey', 'originsecret');
const R = [];
const t = async (name, fn) => { try { const v = await fn(); R.push([name, 'ok', v ?? '']); } catch (e) { R.push([name, 'ERR', `${e.name} ${e.$metadata?.httpStatusCode ?? ''} ${String(e.message).slice(0, 80)}`]); } };
const EV = 'dev-cert-evidence-au', DR = 'dev-cert-draft-au', PUB = 'dev-catalog-public-au', INT = 'dev-intake-au';
await t('create cert-evidence with ObjectLockEnabledForBucket', () => prov.send(new CreateBucketCommand({ Bucket: EV, ObjectLockEnabledForBucket: true })).then(() => 'created'));
await t('versioning status of cert-evidence', () => prov.send(new GetBucketVersioningCommand({ Bucket: EV })).then((r) => r.Status));
await t('object lock configuration', () => prov.send(new GetObjectLockConfigurationCommand({ Bucket: EV })).then((r) => JSON.stringify(r.ObjectLockConfiguration)));
for (const b of [DR, PUB, INT]) await t(`create ${b}`, () => prov.send(new CreateBucketCommand({ Bucket: b })).then(() => 'created'));
await t('lifecycle intake: expire 1 day + abort multipart 1 day', () => prov.send(new PutBucketLifecycleConfigurationCommand({ Bucket: INT, LifecycleConfiguration: { Rules: [
  { ID: 'expire-raw', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] } })).then(() => 'put'));
await t('lifecycle intake roundtrip', () => prov.send(new GetBucketLifecycleConfigurationCommand({ Bucket: INT })).then((r) => JSON.stringify(r.Rules)));
await t('lifecycle cert-draft: noncurrent 1 day', () => prov.send(new PutBucketLifecycleConfigurationCommand({ Bucket: DR, LifecycleConfiguration: { Rules: [
  { ID: 'nc', Status: 'Enabled', Filter: { Prefix: '' }, NoncurrentVersionExpiration: { NoncurrentDays: 1 } }] } })).then(() => 'put'));
const until = new Date(Date.now() + 3600e3);
await t('api put evidence COMPLIANCE lock', () => api.send(new PutObjectCommand({ Bucket: EV, Key: 'k1', Body: 'ciphertext-1', ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: until })).then((r) => r.VersionId));
let vid;
await t('head shows lock', () => api.send(new HeadObjectCommand({ Bucket: EV, Key: 'k1' })).then((r) => { vid = r.VersionId; return `${r.ObjectLockMode} until ${r.ObjectLockRetainUntilDate?.toISOString()} v=${r.VersionId}`; }));
await t('api delete specific version (must be refused)', () => api.send(new DeleteObjectCommand({ Bucket: EV, Key: 'k1', VersionId: vid })).then(() => 'DELETED (bad)'));
await t('api delete current (marker or refused)', () => api.send(new DeleteObjectCommand({ Bucket: EV, Key: 'k1' })).then((r) => `marker=${r.DeleteMarker} v=${r.VersionId}`));
await t('provision delete specific version (must be refused)', () => prov.send(new DeleteObjectCommand({ Bucket: EV, Key: 'k1', VersionId: vid })).then(() => 'DELETED (bad)'));
await t('shorten retention (must be refused)', () => api.send(new PutObjectRetentionCommand({ Bucket: EV, Key: 'k1', VersionId: vid, Retention: { Mode: 'COMPLIANCE', RetainUntilDate: new Date(Date.now() + 60e3) } })).then(() => 'SHORTENED (bad)'));
await t('governance bypass attempt (must be refused)', () => prov.send(new DeleteObjectCommand({ Bucket: EV, Key: 'k1', VersionId: vid, BypassGovernanceRetention: true })).then(() => 'DELETED (bad)'));
await t('list versions of k1', () => prov.send(new ListObjectVersionsCommand({ Bucket: EV, Prefix: 'k1' })).then((r) => `versions=${r.Versions?.length} markers=${r.DeleteMarkers?.length}`));
await t('second put creates another version', () => api.send(new PutObjectCommand({ Bucket: EV, Key: 'k2', Body: 'a' })).then(() => api.send(new PutObjectCommand({ Bucket: EV, Key: 'k2', Body: 'b' }))).then(() => prov.send(new ListObjectVersionsCommand({ Bucket: EV, Prefix: 'k2' }))).then((r) => `versions=${r.Versions?.length}`));
await t('multipart: initiate then list (abort rule)', () => prov.send(new CreateMultipartUploadCommand({ Bucket: INT, Key: 'mp' })).then(() => prov.send(new ListMultipartUploadsCommand({ Bucket: INT }))).then((r) => `uploads=${r.Uploads?.length}`));
// principals
await t('origin GET public object', () => prov.send(new PutObjectCommand({ Bucket: PUB, Key: 'p1', Body: 'img' })).then(() => origin.send(new GetObjectCommand({ Bucket: PUB, Key: 'p1' }))).then((r) => r.Body.transformToString()));
await t('origin PUT public (must be refused)', () => origin.send(new PutObjectCommand({ Bucket: PUB, Key: 'p2', Body: 'x' })).then(() => 'WRITTEN (bad)'));
await t('origin GET evidence (must be refused)', () => origin.send(new GetObjectCommand({ Bucket: EV, Key: 'k2' })).then(() => 'READ (bad)'));
await t('api GET catalog-public (not granted, must be refused)', () => api.send(new GetObjectCommand({ Bucket: PUB, Key: 'p1' })).then(() => 'READ (bad)'));
await t('api PutBucketLifecycle on evidence (must be refused)', () => api.send(new PutBucketLifecycleConfigurationCommand({ Bucket: EV, LifecycleConfiguration: { Rules: [{ ID: 'x', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } }] } })).then(() => 'CHANGED (bad)'));
await t('api PutBucketVersioning (must be refused)', () => api.send(new PutBucketVersioningCommand({ Bucket: EV, VersioningConfiguration: { Status: 'Suspended' } })).then(() => 'CHANGED (bad)'));
await t('api PutBucketPolicy (must be refused)', () => api.send(new PutBucketPolicyCommand({ Bucket: EV, Policy: '{}' })).then(() => 'CHANGED (bad)'));
await t('api PutObjectLockConfiguration (must be refused)', () => api.send(new PutObjectLockConfigurationCommand({ Bucket: EV, ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })).then(() => 'CHANGED (bad)'));
await t('api DeleteBucket (must be refused)', () => api.send(new DeleteBucketCommand({ Bucket: EV })).then(() => 'DELETED (bad)'));
for (const [n, s, d] of R) console.log(`${s === 'ok' ? 'OK ' : 'ERR'} ${n} -> ${d}`);
