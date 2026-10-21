import { ApiProperty } from '@nestjs/swagger';
import {
  STOREFRONT_PALETTES,
  STOREFRONT_TEXT_SIZES,
  type StorefrontPalette,
  type StorefrontTextSize,
} from '../domain/storefront-appearance';

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

/** A customer's kept storefront look; a null part means no choice. */
export class CustomerAppearance {
  @ApiProperty({ type: String, nullable: true, enum: STOREFRONT_PALETTES })
  palette!: StorefrontPalette | null;

  @ApiProperty({ type: String, nullable: true, enum: STOREFRONT_TEXT_SIZES })
  textSize!: StorefrontTextSize | null;
}

/** The new look; null clears a part. */
export class ChangeAppearanceRequest {
  @ApiProperty({ type: String, nullable: true, enum: STOREFRONT_PALETTES })
  palette!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: STOREFRONT_TEXT_SIZES })
  textSize!: string | null;
}

export class AppearanceChanged {
  @ApiProperty({ enum: ['storefront-appearance-changed'] })
  code!: 'storefront-appearance-changed';

  @ApiProperty({ description: 'False when the look already was the one given.' })
  changed!: boolean;
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

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'The previous successful sign-in before this session (ISO 8601 UTC), or null when the ' +
      'records no longer hold one. The time only, never an address.',
  })
  lastSignInAt!: string | null;

  @ApiProperty({ description: 'The sign-in email (personal data: shown to its owner only).' })
  email!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The name the customer set in Settings; null until they set one.',
  })
  displayName!: string | null;

  @ApiProperty({
    type: CustomerAppearance,
    nullable: true,
    description: 'The storefront look kept on the account; null when none was chosen.',
  })
  appearance!: CustomerAppearance | null;

  @ApiProperty({ type: SessionTimes })
  session!: SessionTimes;

  @ApiProperty({ description: 'Send as x-csrf-token on every unsafe request of this session.' })
  csrfToken!: string;
}
