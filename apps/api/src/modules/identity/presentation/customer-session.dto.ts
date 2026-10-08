import { ApiProperty } from '@nestjs/swagger';

/** The body of a customer sign-in (identity design 6.3): email and password only. */
export class CustomerSignInRequest {
  @ApiProperty({ description: 'The sign-in email of the customer account.', maxLength: 254 })
  email!: string;

  @ApiProperty({
    description: 'The password, at most 1024 bytes. Never trimmed, logged or echoed.',
    format: 'password',
  })
  password!: string;
}

/**
 * A signed-in answer. The session token travels only in the `Set-Cookie` header
 * (`__Host-session-customer-<MARKET>`, `HttpOnly`); the CSRF token is the value the page sends
 * as `x-csrf-token` on every unsafe request of this session.
 */
export class CustomerSignedIn {
  @ApiProperty({ enum: ['signed-in'] })
  code!: 'signed-in';

  @ApiProperty({ description: 'Send as x-csrf-token on every POST, PUT, PATCH and DELETE.' })
  csrfToken!: string;
}

export class CustomerSignedOut {
  @ApiProperty({ enum: ['signed-out'] })
  code!: 'signed-out';
}

class SessionTimes {
  @ApiProperty({
    description:
      'The idle timeout: the session ends this many seconds after its last request. The page ' +
      'counts from its own last request; reading this value is itself a request.',
  })
  idleTimeoutSeconds!: number;

  @ApiProperty({ description: 'The absolute expiry, ISO 8601 UTC; never extended.' })
  absoluteExpiresAt!: string;
}

/** The actor summary of identity design 8.6 rows 2 and 9 (customer). */
export class CustomerSessionSummary {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ enum: ['customer'] })
  population!: 'customer';

  @ApiProperty({ type: String, nullable: true, description: 'Null for a customer.' })
  sellerId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Null: a customer holds no role.' })
  roleId!: string | null;

  @ApiProperty({ type: [String], description: 'Empty: a customer holds no permission key.' })
  permissionKeys!: string[];

  @ApiProperty({ type: String, nullable: true, description: 'Null for a customer.' })
  sellerAccessState!: string | null;

  @ApiProperty()
  secondFactorActive!: boolean;

  @ApiProperty({ description: 'The sign-in email (personal data: shown to its owner only).' })
  email!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Null for a customer.' })
  displayName!: string | null;

  @ApiProperty({ type: SessionTimes })
  session!: SessionTimes;

  @ApiProperty({ description: 'Send as x-csrf-token on every unsafe request of this session.' })
  csrfToken!: string;
}
