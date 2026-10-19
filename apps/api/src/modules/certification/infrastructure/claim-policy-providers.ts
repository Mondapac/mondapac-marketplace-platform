import type { FactoryProvider, Provider } from '@nestjs/common';
import type { IdGenerator } from '@mondapac/shared-kernel';
import { USE_CASE_GATE, type UseCaseGate } from '../../../platform/authz';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  CATALOG_REFERENCES,
  type CatalogReferences,
} from '../application/ports/catalog-references';
import {
  CLAIM_POLICY_REPOSITORY,
  type ClaimPolicyRepository,
} from '../application/ports/claim-policy.repository';
import type { ClaimPolicyDependencies } from '../application/registry/claim-policy.shared';
import type { RegistryDependencies } from '../application/registry/registry.shared';
import { ClaimPolicyApproveRelaxation } from '../application/use-cases/claim-policy-approve-relaxation.use-case';
import { ClaimPolicyProposalReject } from '../application/use-cases/claim-policy-proposal-reject.use-case';
import { ClaimPolicyProposalWithdraw } from '../application/use-cases/claim-policy-proposal-withdraw.use-case';
import { ClaimPolicyRead } from '../application/use-cases/claim-policy-read.use-case';
import { ClaimPolicySaveRevision } from '../application/use-cases/claim-policy-save-revision.use-case';
import { PrismaClaimPolicyRepository } from './prisma-claim-policy.repository';
import { REGISTRY_DEPENDENCIES } from './registry-providers';

const CLAIM_POLICY_DEPENDENCIES = Symbol('CERTIFICATION_CLAIM_POLICY_DEPENDENCIES');

/** The admin use cases behind the claim-policy page (slice 13). */
export const claimPolicyUseCases = [
  ClaimPolicyRead,
  ClaimPolicySaveRevision,
  ClaimPolicyApproveRelaxation,
  ClaimPolicyProposalReject,
  ClaimPolicyProposalWithdraw,
] as const;

/**
 * The claim basis policy (certification design 3.7, 7.1, 7.2; slice 13): the store, the admin
 * use cases on the registry's dependencies, and `catalog`'s `CatalogReferences` binding (global,
 * from `catalog`'s references module; unbound, the application does not start).
 */
export const claimPolicyProviders: readonly Provider[] = [
  {
    provide: CLAIM_POLICY_REPOSITORY,
    inject: [PrismaService, ID_GENERATOR],
    useFactory: (prisma: PrismaService, ids: IdGenerator): ClaimPolicyRepository =>
      new PrismaClaimPolicyRepository(prisma, ids),
  },
  {
    provide: CLAIM_POLICY_DEPENDENCIES,
    inject: [REGISTRY_DEPENDENCIES, CLAIM_POLICY_REPOSITORY, CATALOG_REFERENCES],
    useFactory: (
      registry: RegistryDependencies,
      policies: ClaimPolicyRepository,
      catalog: CatalogReferences,
    ): ClaimPolicyDependencies => ({ ...registry, policies, catalog }),
  },
  ...claimPolicyUseCases.map((type): FactoryProvider => ({
    provide: type,
    inject: [USE_CASE_GATE, CLAIM_POLICY_DEPENDENCIES],
    useFactory: (gate: UseCaseGate, deps: ClaimPolicyDependencies) => new type(gate, deps),
  })),
];
