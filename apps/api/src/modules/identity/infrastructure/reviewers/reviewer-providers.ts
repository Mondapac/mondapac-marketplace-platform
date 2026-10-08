import type { FactoryProvider } from '@nestjs/common';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { AccountAccessReviewers } from '../../application/access/account-access-reviewers';
import {
  ACCESS_REVIEWERS,
  REVIEWER_CANDIDATE_READER,
  type AccessReviewers,
  type ReviewerCandidateReader,
} from '../../application/ports/access-reviewers';
import { PrismaReviewerCandidateReader } from './prisma-reviewer-candidate-reader';

/**
 * Binds the reviewer read of the reviewer notice (identity design 8.7): the SQL candidate reader
 * (here because only `infrastructure/` may reach `PrismaService`) and the application's
 * `AccountAccessReviewers`, which decides who may review with `effectiveKeysOf`.
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
    inject: [UNIT_OF_WORK, REVIEWER_CANDIDATE_READER],
    useFactory: (unitOfWork: UnitOfWork, candidates: ReviewerCandidateReader): AccessReviewers =>
      new AccountAccessReviewers({ unitOfWork, candidates }),
  },
];
