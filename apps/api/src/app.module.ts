import { Module } from '@nestjs/common';

/**
 * Composition root of the modular monolith (ADR-0008). Platform runtime and the
 * bounded-context modules are registered here as the skeleton grows.
 */
@Module({})
export class AppModule {}
