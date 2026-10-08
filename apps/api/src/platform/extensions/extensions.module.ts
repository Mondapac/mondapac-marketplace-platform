import { Global, Module } from '@nestjs/common';
import { ExtensionPointRegistry } from './extension-point-registry';

/** Provides the one {@link ExtensionPointRegistry}, sealed when the application bootstraps. */
@Global()
@Module({
  providers: [ExtensionPointRegistry],
  exports: [ExtensionPointRegistry],
})
export class ExtensionsModule {}
