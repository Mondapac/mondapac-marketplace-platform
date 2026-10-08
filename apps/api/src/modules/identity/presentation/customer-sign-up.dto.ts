import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** The body of a customer sign-up (identity design 6.5, 6.7; `ux.md` A2: email and password). */
export class CustomerSignUpRequest {
  @ApiProperty({
    description:
      'The sign-in email. Trimmed; compared without case and in Unicode NFC, per Market and ' +
      'account type.',
    maxLength: 254,
    example: 'customer@example.com',
  })
  email!: string;

  @ApiProperty({
    description:
      "The new password: within the Market's length limits, counted in characters after " +
      'Unicode NFKC (never fewer than 15 nor more than 128); at most 1024 bytes; not equal to ' +
      'the email; not a common password. Never trimmed, logged or echoed.',
    format: 'password',
  })
  password!: string;
}

/** The answer for every address, whether or not it already has an account (AC 21). */
export class CustomerSignUpAccepted {
  @ApiProperty({ enum: ['sign-up.accepted'] })
  code!: 'sign-up.accepted';
}

class FieldProblemBody {
  @ApiProperty({ example: 'email' })
  path!: string;

  @ApiProperty({ enum: ['required', 'type', 'format', 'length', 'unknown-field'] })
  code!: string;
}

class ErrorDetailsBody {
  @ApiPropertyOptional({ type: [FieldProblemBody], description: 'validation.failed' })
  fields?: FieldProblemBody[];

  @ApiPropertyOptional({
    enum: ['length', 'common', 'contains-identity'],
    description: 'password.rejected',
  })
  rule?: string;

  @ApiPropertyOptional({ description: 'request.busy and request.throttled' })
  retryAfterSeconds?: number;
}

/** The error format of identity design 5.2: `{ statusCode, code, details? }`, codes only. */
export class ApiErrorBody {
  @ApiProperty()
  statusCode!: number;

  @ApiProperty({
    enum: [
      'validation.failed',
      'password.rejected',
      'request.body-unsupported',
      'request.throttled',
      'request.busy',
      'request.csrf',
      'session.invalid',
      'credentials.invalid',
      'email-verification-required',
      'account.disabled',
      'access.unauthenticated',
      'access.denied',
      'access.unavailable',
      'conflict.retry',
    ],
  })
  code!: string;

  @ApiPropertyOptional({ type: ErrorDetailsBody })
  details?: ErrorDetailsBody;
}
