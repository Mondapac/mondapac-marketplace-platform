import { Module } from '@nestjs/common';
import { pricingProviders } from './infrastructure/pricing-providers';

/**
 * The pricing module (ADR-0024). Slice 1 so far: the pure domain (part 1) and its persistence
 * ports (part 2). Use cases, the facade, permissions, routes and handlers arrive in part 3.
 */
@Module({ providers: [...pricingProviders] })
export class PricingModule {}
