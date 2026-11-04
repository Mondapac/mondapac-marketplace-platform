// Violation: the AWS S3 client is imported only by platform/storage/s3-object-store.ts (file storage pilot F2).
export { S3Client } from '@aws-sdk/client-s3';
