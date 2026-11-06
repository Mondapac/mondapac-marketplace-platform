import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Where a correct agent password leads: never to a session, always to a code (ADR-0045 d4). */
export class AgentSignInStep {
  @ApiProperty({ enum: ['second-factor-required'] })
  code!: 'second-factor-required';

  @ApiPropertyOptional({
    description:
      'The challenge token, posted back with the code. Not a credential; it works for a few ' +
      'minutes and a few attempts.',
    example: 'mc1_…',
  })
  challengeToken?: string;

  @ApiPropertyOptional({ description: "The challenge's expiry, ISO 8601 UTC." })
  expiresAt?: string;
}

/**
 * Accepting an agent invitation in one request (ADR-0045 decision 2): the link token, the handover
 * code the admin gave in person, a password, the secret's three parts from the preview and the
 * first code from the app. Nothing here is logged or echoed.
 */
export class AgentAcceptInvitationRequest {
  @ApiProperty({
    description: "The token from the fragment of the invitation's link.",
    example: 'mi1_…',
  })
  token!: string;

  @ApiProperty({
    description: 'The handover code, ten characters shown as XXXXX-XXXXX. Five failures void it.',
    example: 'ABCDE-23456',
  })
  handoverCode!: string;

  @ApiProperty({ format: 'password', description: 'The new password, at most 1024 bytes.' })
  password!: string;

  @ApiProperty({ description: 'The secret as the preview returned it.' })
  secret!: string;

  @ApiProperty({ description: "The secret's tag, unchanged." })
  tag!: string;

  @ApiProperty({ description: "The secret's expiry, ISO 8601 UTC, unchanged." })
  expiresAt!: string;

  @ApiProperty({ description: 'The first six-digit code from the authenticator app.' })
  code!: string;
}

/** The signed-in agent's account and session. Never a role or a permission: an agent holds none. */
export class AgentSessionSummary {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ enum: ['agent'] })
  population!: 'agent';

  @ApiProperty()
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  timezone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locale!: string | null;

  @ApiProperty({
    type: 'object',
    properties: {
      idleTimeoutSeconds: { type: 'number' },
      absoluteExpiresAt: { type: 'string' },
    },
  })
  session!: { idleTimeoutSeconds: number; absoluteExpiresAt: string };

  @ApiProperty({ description: 'Send as x-csrf-token on every POST, PUT, PATCH and DELETE.' })
  csrfToken!: string;
}
