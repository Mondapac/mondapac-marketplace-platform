import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The body of a seller sign-up (identity design 3.1, 6.5, 6.7; `ux.md` A2, F4 step 1): name,
 * email and password.
 */
export class SellerSignUpRequest {
  @ApiProperty({
    description:
      "The person's display name: 1 to 100 characters after trimming, with no control or " +
      'bidi characters and no URL-like text. Personal data: never logged.',
    maxLength: 100,
    example: 'Amina Rahman',
  })
  displayName!: string;

  @ApiProperty({
    description:
      'The sign-in email. Trimmed; compared without case and in Unicode NFC, per Market and ' +
      'account type: a customer account with the same email is separate.',
    maxLength: 254,
    example: 'owner@example.com',
  })
  email!: string;

  @ApiProperty({
    description:
      "The new password: within the Market's length limits, counted in characters after " +
      'Unicode NFKC; at most 1024 bytes; containing neither the email nor the name; not a ' +
      'common password. Never trimmed, logged or echoed.',
    format: 'password',
  })
  password!: string;
}

/** The body of a seller-side sign-in (identity design 6.1, 6.3). */
export class SellerSignInRequest {
  @ApiProperty({ description: 'The sign-in email of the seller-side account.', maxLength: 254 })
  email!: string;

  @ApiProperty({
    description: 'The password, at most 1024 bytes. Never trimmed, logged or echoed.',
    format: 'password',
  })
  password!: string;

  @ApiPropertyOptional({
    description:
      '"Keep me signed in" (default false): the session lasts 14 days idle and 30 days in all, ' +
      'in a cookie that outlives the browser. Otherwise 12 hours idle and 24 in all, in a ' +
      "cookie that ends with the browser. Values are the Market's.",
    default: false,
  })
  keepSignedIn?: boolean;
}

/** The body that confirms a seller-side account's email: the link's token and the password. */
export class SellerConfirmEmailRequest {
  @ApiProperty({
    description:
      "The token from the fragment of the mail's link (never in a URL the server sees). Never " +
      'logged or echoed.',
    example: 'ml1_…',
  })
  token!: string;

  @ApiProperty({
    description:
      'The password of the account, at most 1024 bytes. Never trimmed, logged or echoed.',
    format: 'password',
  })
  password!: string;

  @ApiPropertyOptional({ description: '"Keep me signed in", as at sign-in.', default: false })
  keepSignedIn?: boolean;
}

/** A seller-side signed-in answer. The session token travels only in the `Set-Cookie` header. */
export class SellerSignedIn {
  @ApiProperty({ enum: ['signed-in'] })
  code!: 'signed-in';

  @ApiProperty({ description: 'Send as x-csrf-token on every POST, PUT, PATCH and DELETE.' })
  csrfToken!: string;

  @ApiProperty({
    enum: ['pending', 'approved', 'rejected'],
    description:
      "The seller's access state. pending and rejected sign in to a limited session: the panel " +
      'opens the status page, and only the allow-listed requests are answered (identity design ' +
      '3.3, 5.2).',
  })
  sellerAccess!: 'pending' | 'approved' | 'rejected';
}

class SellerSessionTimes {
  @ApiProperty({ description: 'The idle timeout in seconds, counted from the last request.' })
  idleTimeoutSeconds!: number;

  @ApiProperty({ description: 'The absolute expiry, ISO 8601 UTC; never extended.' })
  absoluteExpiresAt!: string;
}

/** The actor summary of identity design 8.6 rows 2 and 9, for a seller-side account. */
export class SellerSessionSummary {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ enum: ['seller'] })
  population!: 'seller';

  @ApiProperty({ format: 'uuid', description: 'The seller the account works for.' })
  sellerId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The account's role (one in Phase 2).",
  })
  roleId!: string | null;

  @ApiProperty({ type: [String], description: 'Empty until slice 8a.' })
  permissionKeys!: string[];

  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] })
  sellerAccessState!: string;

  @ApiProperty()
  secondFactorActive!: boolean;

  @ApiProperty({ description: 'The sign-in email (personal data: shown to its owner only).' })
  email!: string;

  @ApiProperty({ description: "The person's display name (personal data)." })
  displayName!: string;

  @ApiProperty({ type: SellerSessionTimes })
  session!: SellerSessionTimes;

  @ApiProperty({ description: 'Send as x-csrf-token on every unsafe request of this session.' })
  csrfToken!: string;
}

/** The status page of a seller-side account (`ux.md` S1; identity design 3.3). */
export class SellerStatusBody {
  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ enum: ['pending', 'approved', 'rejected'] })
  state!: string;

  @ApiProperty({ description: 'The instant of the latest state change, ISO 8601 UTC.' })
  stateChangedAt!: string;

  @ApiProperty({ description: 'When the account was created, ISO 8601 UTC.' })
  accountCreatedAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'When the email was confirmed.' })
  emailConfirmedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The reason of a rejection, for the Seller Owner only. Always null until the decisions ' +
      'of identity slice 9.',
  })
  reason!: string | null;
}
