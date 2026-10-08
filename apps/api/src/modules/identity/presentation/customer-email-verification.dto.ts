import { ApiProperty } from '@nestjs/swagger';

/**
 * The body that confirms a customer's email (identity design 3.2, 6.3, 6.7 option B): the token
 * from the link's fragment and the account's password. A correct password confirms the email
 * and signs in.
 */
export class CustomerConfirmEmailRequest {
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
}

/** The body that asks for a new verification mail (`ux.md` A3 "Send it again", A4). */
export class CustomerVerificationEmailRequest {
  @ApiProperty({ description: 'The sign-in email of the customer account.', maxLength: 254 })
  email!: string;
}

/** The answer for every address, whether or not a mail goes (AC 21). */
export class CustomerVerificationEmailAccepted {
  @ApiProperty({ enum: ['verification-resend.accepted'] })
  code!: 'verification-resend.accepted';
}
