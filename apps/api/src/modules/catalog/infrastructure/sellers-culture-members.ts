import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { FactoryProvider } from '@nestjs/common';
import { SELLERS_FACADE, type SellersFacade } from '../../sellers';
import {
  SELLERS_CULTURE_DEMOTE_PORT,
  type CultureDemotePort,
} from '../../sellers/contracts/culture-demote.port';
import {
  CULTURE_MEMBERS,
  type CultureMembers,
  type CultureMembersUnavailable,
} from '../application/ports/culture-members';

const UNAVAILABLE = err({ code: 'culture-members.unavailable' } as const);

/**
 * {@link CultureMembers} over `sellers.cultureHasApprovedMembers` and sellers' restricted culture
 * demotion port; anything but a boolean is unavailable. This file is the only one outside `sellers`
 * that may import the port (ADR-0048 security review N2, dependency-cruiser rule
 * `culture-demote-port-is-for-catalog-adapter`), so it also owns the provider that injects it.
 */
export class SellersCultureMembers implements CultureMembers {
  constructor(
    private readonly sellers: SellersFacade,
    private readonly demotion: CultureDemotePort,
  ) {}

  async hasApproved(
    context: CallContext,
    cultureId: Id<'Culture'>,
  ): Promise<Result<boolean, CultureMembersUnavailable>> {
    try {
      const answer = await this.sellers.cultureHasApprovedMembers(context, cultureId);
      return answer.ok && typeof answer.value === 'boolean' ? ok(answer.value) : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  async demoteAll(
    context: CallContext,
    cultureId: Id<'Culture'>,
  ): Promise<Result<boolean, CultureMembersUnavailable>> {
    try {
      const done = await this.demotion.cultureDemoteApprovals(context, cultureId);
      return done.ok && typeof done.value?.remaining === 'boolean'
        ? ok(!done.value.remaining)
        : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }
}

/** The provider of {@link CULTURE_MEMBERS}: the sellers facade and the restricted demotion port. */
export const cultureMembersProvider: FactoryProvider<CultureMembers> = {
  provide: CULTURE_MEMBERS,
  inject: [SELLERS_FACADE, SELLERS_CULTURE_DEMOTE_PORT],
  useFactory: (sellers: SellersFacade, demotion: CultureDemotePort): CultureMembers =>
    new SellersCultureMembers(sellers, demotion),
};
