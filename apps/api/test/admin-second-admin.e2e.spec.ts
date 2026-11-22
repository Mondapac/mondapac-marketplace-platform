import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { INestApplication } from '@nestjs/common';
import { AcceptAdminInvitation } from '../src/modules/identity/application/use-cases/accept-admin-invitation.use-case';
import { IssueFirstAdminInvitation } from '../src/modules/identity/application/use-cases/issue-first-admin-invitation.use-case';
import { IssueSecondAdminInvitation } from '../src/modules/identity/application/use-cases/issue-second-admin-invitation.use-case';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendInvitationMail } from '../src/modules/identity/application/use-cases/send-invitation-mail.use-case';
import { StartAdminInvitationAcceptance } from '../src/modules/identity/application/use-cases/start-admin-invitation-acceptance.use-case';
import { decodeBase32Secret } from '../src/modules/identity/domain/otpauth';
import { TOTP } from '../src/modules/identity/domain/totp';
import { hotp } from '../src/modules/identity/infrastructure/second-factor/totp';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The operator's `second-admin` routine (owner decision 22 Nov 2026): the bootstrap of a Market's
// second admin, which a Market with one admin could not add while people is reviewed (nobody else
// can approve the invitation). The real use cases with identity's ports as in-memory fakes: it
// issues once, only while the Market has exactly one active Platform Administrator and no pending
// admin invitation, names that admin as the inviter (so acceptance re-checks a live inviter and
// never takes the first-admin path), and closes for good once the second admin exists.

const START = Temporal.Instant.from('2026-11-22T06:00:00Z');
const FIRST = 'first.admin@ops.example';
const SECOND = 'second.admin@ops.example';
const PASSWORD = 'correct horse battery staple';
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };

const fakes = new IdentityFakes();
let clock: FixedClock;
let deliveries = 0;

describe.each(TEST_MARKETS)('the second-admin routine in market %s', (code) => {
  let app: INestApplication;
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const system = () => testCallContext(market, 'system', 'second-admin-0001');
  const anonymous = () => testCallContext(market, 'anonymous', 'second-admin-0002');
  const codeFor = (secret: string) =>
    hotp(
      decodeBase32Secret(secret)!,
      Math.floor(clock.now().epochMilliseconds / 1000 / TOTP.periodSeconds),
    );
  const invitationsTo = (email: string) =>
    [...fakes.invitations.values()].filter((i) => i.email?.normalized === email);

  /** Runs the mail of the latest issued invitation; answers its token. */
  async function mailed(): Promise<string> {
    const event = fakes.events.filter((e) => e.type === 'identity.invitation-issued.v1').at(-1)!;
    const sent = await app.get(SendInvitationMail).execute(system(), {
      delivery: {
        eventId: `0199eeee-0000-7000-8000-${String(++deliveries).padStart(12, '0')}` as Id<'event'>,
        subscriber: 'identity.invitation-mail',
        attempt: 1,
      },
      invitationId: (event.payload as { invitationId: Id }).invitationId,
      aggregateVersion: event.aggregateVersion,
    });
    expect(sent).toMatchObject({ ok: true });
    return /#(mi1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
  }

  async function accept(token: string, displayName: string) {
    const ready = await app
      .get(StartAdminInvitationAcceptance)
      .execute(anonymous(), { token, client: CLIENT });
    if (!ready.ok) throw new Error(`enrolment refused: ${ready.error.code}`);
    return app.get(AcceptAdminInvitation).execute(anonymous(), {
      token,
      displayName,
      password: PASSWORD,
      secret: ready.value.secret,
      tag: ready.value.tag,
      expiresAt: ready.value.expiresAt.toString(),
      code: codeFor(ready.value.secret),
      client: CLIENT,
    });
  }

  async function firstAdmin() {
    await app.get(SeedRoles).execute(system(), {});
    const issued = await app.get(IssueFirstAdminInvitation).execute(system(), { email: FIRST });
    expect(issued).toMatchObject({ ok: true });
    await expect(accept(await mailed(), 'First Admin')).resolves.toMatchObject({ ok: true });
  }

  const second = (email = SECOND) =>
    app.get(IssueSecondAdminInvitation).execute(system(), { email });

  beforeEach(async () => {
    fakes.reset();
    clock = new FixedClock(START);
    ({ app } = await createTestApp({
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses before the first admin exists, and before the role seed', async () => {
    await expect(second()).resolves.toEqual({ ok: false, error: { code: 'roles.not-seeded' } });
    await app.get(SeedRoles).execute(system(), {});
    await expect(second()).resolves.toEqual({
      ok: false,
      error: { code: 'second-admin.no-first-admin' },
    });
    // A pending first-admin invitation is no admin account yet.
    await app.get(IssueFirstAdminInvitation).execute(system(), { email: FIRST });
    await expect(second()).resolves.toEqual({
      ok: false,
      error: { code: 'second-admin.no-first-admin' },
    });
    expect(invitationsTo(SECOND)).toHaveLength(0);
  });

  it('invites one second Platform Administrator with the first admin as inviter, once', async () => {
    await firstAdmin();
    const first = [...fakes.accounts.values()].find((a) => a.population === 'admin')!;

    const issued = await second();
    expect(issued).toMatchObject({ ok: true, value: { code: 'invitation.issued' } });
    const [invitation] = invitationsTo(SECOND);
    expect(invitation).toMatchObject({
      kind: 'admin',
      sellerId: null,
      invitedByAccountId: first.id,
    });
    expect(fakes.audits.at(-1)).toMatchObject({
      action: 'identity.invitation.issued',
      actor: 'system',
    });

    // While it is pending, the routine issues nothing more, for this or any other address.
    await expect(second()).resolves.toEqual({
      ok: false,
      error: { code: 'invitation.already-pending' },
    });
    await expect(second('third.admin@ops.example')).resolves.toEqual({
      ok: false,
      error: { code: 'invitation.already-pending' },
    });

    await expect(accept(await mailed(), 'Second Admin')).resolves.toMatchObject({ ok: true });
    const admins = [...fakes.accounts.values()].filter((a) => a.population === 'admin');
    expect(admins).toHaveLength(2);

    // Two admins: the bootstrap is over; the panel (and its review) takes over.
    await expect(second('third.admin@ops.example')).resolves.toEqual({
      ok: false,
      error: { code: 'second-admin.not-bootstrap' },
    });
  });

  it('refuses when the one admin is disabled', async () => {
    await firstAdmin();
    const first = [...fakes.accounts.values()].find((a) => a.population === 'admin')!;
    fakes.accounts.set(first.id, { ...first, status: 'disabled' });
    await expect(second()).resolves.toEqual({
      ok: false,
      error: { code: 'second-admin.not-bootstrap' },
    });
  });

  it('stays closed while any admin invitation is pending: expired or held for approval too', async () => {
    await firstAdmin();
    await expect(second()).resolves.toMatchObject({ ok: true });
    const [issued] = invitationsTo(SECOND);

    // Past its lifetime it is still pending until revoked (revoking is not reviewed).
    clock.advance(Temporal.Duration.from({ hours: 30 * 24 }));
    await expect(second('third.admin@ops.example')).resolves.toEqual({
      ok: false,
      error: { code: 'invitation.already-pending' },
    });
    // A panel invitation held for another admin's approval blocks it as well.
    fakes.invitations.set(issued!.id, { ...issued!, heldForApproval: true });
    await expect(second('third.admin@ops.example')).resolves.toEqual({
      ok: false,
      error: { code: 'invitation.already-pending' },
    });
  });

  it('refuses when the one admin no longer holds the Platform Administrator role', async () => {
    await firstAdmin();
    const first = [...fakes.accounts.values()].find((a) => a.population === 'admin')!;
    for (const [id, assignment] of fakes.assignments) {
      if (assignment.accountId === first.id) fakes.assignments.delete(id);
    }
    await expect(second()).resolves.toEqual({
      ok: false,
      error: { code: 'second-admin.not-bootstrap' },
    });
  });

  it('refuses the acceptance once the named inviter is disabled after the issue', async () => {
    await firstAdmin();
    await expect(second()).resolves.toMatchObject({ ok: true });
    const token = await mailed();
    const first = [...fakes.accounts.values()].find((a) => a.population === 'admin')!;
    fakes.accounts.set(first.id, { ...first, status: 'disabled' });
    await expect(accept(token, 'Second Admin')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invitation.rejected' },
    });
    expect([...fakes.accounts.values()].filter((a) => a.population === 'admin')).toHaveLength(1);
  });

  it('is a system routine only', async () => {
    await firstAdmin();
    await expect(
      app.get(IssueSecondAdminInvitation).execute(anonymous(), { email: SECOND }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
    expect(invitationsTo(SECOND)).toHaveLength(0);
  });

  it('refuses an address that is not one', async () => {
    await firstAdmin();
    await expect(second('not an address')).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed' },
    });
  });
});
