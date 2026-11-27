import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { ViewPasswordRules } from '../application/use-cases/view-password-rules.use-case';

/** The request Market's password length rule (identity design 6.5). */
export class PasswordRulesBody {
  @ApiProperty({ description: 'Fewest characters, counted after Unicode NFKC', example: 15 })
  minLength!: number;

  @ApiProperty({ description: 'Most characters, counted after Unicode NFKC', example: 128 })
  maxLength!: number;
}

/**
 * The password rule the storefront's Create account form shows (`ux.md` A2: "Password with
 * show/hide and the policy rule"). No session is read: the actor is the Market's anonymous
 * actor. A safe GET with no input, so the population only names the allow-list an unsafe request
 * would use (none here). The answer is the Market's configuration, never anything about an
 * account.
 */
@ApiTags('identity')
@RoutePopulation('customer')
@Controller('identity/customer/password-rules')
export class CustomerPasswordRulesController {
  constructor(private readonly view: ViewPasswordRules) {}

  @Get()
  @ApiOperation({
    summary: "The Market's password length rule (public)",
    description: 'No session needed. The same numbers the sign-up and password changes check.',
  })
  @ApiOkResponse({ type: PasswordRulesBody })
  async rules(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PasswordRulesBody> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.view.execute(context, {});
    // The use case cannot fail: its error type is never.
    if (!result.ok) throw new Error('identity.view-password-rules cannot fail');
    return result.value;
  }
}
