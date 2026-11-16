import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { IDENTITY_FACADE, IdentityModule, type IdentityFacade } from '../identity';
import { CUSTOMER_SECTION_PEERS } from './application/ports/customer-section-peers';
import type { LateBoundSectionPeers } from './infrastructure/late-bound-section-peers';
import { CustomersModule } from './customers.module';

/**
 * Binds the customer page's sections (customers management phase 2b) to the modules that own
 * their data. A module of its own because several owners reach `ordering`, which imports
 * `customers`: `CustomersModule` provides the section use cases with peers that refuse (fail
 * closed) until this module binds the real facades at start. Registered beside the other
 * customers binding modules in `modules/index.ts`; not exported from the customers entry point.
 */
@Module({
  imports: [CustomersModule, IdentityModule],
})
export class CustomersSectionsModule implements OnModuleInit {
  constructor(
    @Inject(CUSTOMER_SECTION_PEERS) private readonly peers: LateBoundSectionPeers,
    @Inject(IDENTITY_FACADE) private readonly identity: IdentityFacade,
  ) {}

  onModuleInit(): void {
    this.peers.bind({ identity: this.identity });
  }
}
