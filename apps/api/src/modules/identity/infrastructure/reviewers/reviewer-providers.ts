import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { AccountAccessReviewers } from '../../application/access/account-access-reviewers';
import {
  EFFECTIVE_KEY_RESOLVER,
  type EffectiveKeyResolver,
} from '../../application/access/effective-keys';
import {
  ACCESS_REVIEWERS,
  REVIEWER_CANDIDATE_READER,
  type AccessReviewers,
  type ReviewerCandidateReader,
} from '../../application/ports/access-reviewers';
import { ROLE_GRANT_READER, type RoleGrantReader } from '../../application/ports/role-grant-reader';
import { PrismaReviewerCandidateReader } from './prisma-reviewer-candidate-reader';

/**
 * Binds the reviewer read of the reviewer notice (identity design 8.7): the SQL candidate reader
 * (here because only `infrastructure/` may reach `PrismaService`) and the application's
 * `AccountAccessReviewers`, which decides who may review with the shared resolver of
 * `EFFECTIVE_KEY_RESOLVER` over the grant read (slice 8a-1; R-3 review N-1). The factor lookup
 * stays the empty store until slice 7.
 */
export const reviewerProviders: readonly FactoryProvider[] = [
  {
    provide: REVIEWER_CANDIDATE_READER,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService): ReviewerCandidateReader =>
      new PrismaReviewerCandidateReader(prisma),
  },
  {
    provide: ACCESS_REVIEWERS,
    inject: [UNIT_OF_WORK, REVIEWER_CANDIDATE_READER, ROLE_GRANT_READER, EFFECTIVE_KEY_RESOLVER],
    useFactory: (
      unitOfWork: UnitOfWork,
      candidates: ReviewerCandidateReader,
      grants: RoleGrantReader,
      effectiveKeys: EffectiveKeyResolver,
    ): AccessReviewers =>
      new AccountAccessReviewers({ unitOfWork, candidates, grants, effectiveKeys }),
  },
];
