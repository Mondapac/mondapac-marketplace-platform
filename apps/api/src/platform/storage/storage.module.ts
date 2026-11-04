import { Global, Logger, Module } from '@nestjs/common';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { DiskObjectStore, UnconfiguredObjectStore } from './disk-object-store';
import { OBJECT_STORE, type ObjectStore } from './object-store';
import { S3ObjectStore } from './s3-object-store';

/**
 * Chooses the adapter from the configuration. The S3 adapter is checked before the application
 * starts: a wrong bucket or region, or a bucket open to the public, stops the process.
 */
export async function objectStoreFor(config: AppConfig): Promise<ObjectStore> {
  const settings = config.objectStore;
  if (settings === null) return new UnconfiguredObjectStore();
  if (settings.driver === 'disk') {
    if (config.nodeEnv === 'production') {
      new Logger('ObjectStore').warn(
        'object store driver is disk: the API and the worker must share this directory, and it ' +
          'needs an off-server backup',
      );
    }
    return new DiskObjectStore(settings.dir);
  }
  const store = new S3ObjectStore(settings);
  await store.verify();
  return store;
}

/** Global: exports the port's token only. */
@Global()
@Module({
  providers: [{ provide: OBJECT_STORE, inject: [APP_CONFIG], useFactory: objectStoreFor }],
  exports: [OBJECT_STORE],
})
export class StorageModule {}
