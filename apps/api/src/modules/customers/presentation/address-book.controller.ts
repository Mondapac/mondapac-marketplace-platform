import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CreateAddress } from '../application/use-cases/create-address.use-case';
import { DeleteAddress } from '../application/use-cases/delete-address.use-case';
import { ListAddresses } from '../application/use-cases/list-addresses.use-case';
import { SetDefaultAddress } from '../application/use-cases/set-default-address.use-case';
import { UpdateAddress } from '../application/use-cases/update-address.use-case';
import { ADDRESS_FIELDS } from '../domain/address';
import {
  AddressBody,
  AddressBookBody,
  AddressRequest,
  DeletedBody,
  addressBody,
  addressBookBody,
} from './address-book.dto';
import { closedBody, refusal } from './http-answers';

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERROR = { type: Object };
const BODY_FIELDS: readonly string[] = [...ADDRESS_FIELDS, 'isDefault'];

/** Logs the route's outcome: a code, never an address value or an id of the customer's. */
function logRoute(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}

/**
 * The signed-in customer's delivery address book. Thin adapters: the customer comes from the
 * session, never from the body or the path; each use case does its work behind its gate and
 * reaches only the caller's own addresses. Every answer is `Cache-Control: no-store`.
 */
@ApiTags('customers')
@RoutePopulation('customer')
@ReadsSession()
@Controller('customers/me/addresses')
export class AddressBookController {
  readonly #logger = new Logger('AddressBookController');

  constructor(
    private readonly list: ListAddresses,
    private readonly create: CreateAddress,
    private readonly update: UpdateAddress,
    private readonly remove: DeleteAddress,
    private readonly makeDefault: SetDefaultAddress,
  ) {}

  @Get()
  @ApiOperation({ summary: "The customer's delivery addresses, the default first" })
  @ApiOkResponse({ type: AddressBookBody })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async index(@Call() context: CallContext, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.list.execute(context, {});
    logRoute(
      this.#logger,
      'customers.list-addresses-route',
      context,
      result.ok ? 'read' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return addressBookBody(result.value);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a delivery address',
    description:
      "The first address, or one sent with isDefault true, becomes the default. At most the Market's limit of addresses.",
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AddressRequest })
  @ApiCreatedResponse({ type: AddressBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiUnprocessableEntityResponse({
    ...ERROR,
    description: 'customers.address-limit-reached (details.limit)',
  })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async post(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, BODY_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.create.execute(context, requestBody as Record<string, unknown>);
    logRoute(
      this.#logger,
      'customers.create-address-route',
      context,
      result.ok ? 'created' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return addressBody(result.value);
  }

  @Put(':addressId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Change a delivery address',
    description: 'Replaces the whole address. Orders already placed keep the copy they were given.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'addressId', format: 'uuid' })
  @ApiBody({ type: AddressRequest })
  @ApiOkResponse({ type: AddressBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.address-not-found' })
  @ApiUnsupportedMediaTypeResponse({ ...ERROR, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async put(
    @Call() context: CallContext,
    @Param('addressId') addressId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() requestBody: unknown,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const invalid = closedBody(request, requestBody, BODY_FIELDS);
    if (invalid !== null) throw invalid;
    const result = await this.update.execute(context, {
      addressId,
      body: requestBody as Record<string, unknown>,
    });
    logRoute(
      this.#logger,
      'customers.update-address-route',
      context,
      result.ok ? 'updated' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return addressBody(result.value);
  }

  @Post(':addressId/default')
  @HttpCode(200)
  @ApiOperation({ summary: 'Make an address the default; answers the whole book' })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'addressId', format: 'uuid' })
  @ApiOkResponse({ type: AddressBookBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.address-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async setDefault(
    @Call() context: CallContext,
    @Param('addressId') addressId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.makeDefault.execute(context, { addressId });
    logRoute(
      this.#logger,
      'customers.set-default-address-route',
      context,
      result.ok ? 'set' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return addressBookBody(result.value);
  }

  @Delete(':addressId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Remove a delivery address',
    description: 'When it was the default, the newest remaining address becomes the default.',
  })
  @ApiHeader(CSRF)
  @ApiParam({ name: 'addressId', format: 'uuid' })
  @ApiOkResponse({ type: DeletedBody })
  @ApiBadRequestResponse({ ...ERROR, description: 'validation.failed' })
  @ApiUnauthorizedResponse({ ...ERROR, description: 'access.unauthenticated or session.invalid' })
  @ApiForbiddenResponse({ ...ERROR, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ ...ERROR, description: 'customers.address-not-found' })
  @ApiServiceUnavailableResponse({ ...ERROR, description: 'customers.unavailable' })
  async delete(
    @Call() context: CallContext,
    @Param('addressId') addressId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.remove.execute(context, { addressId });
    logRoute(
      this.#logger,
      'customers.delete-address-route',
      context,
      result.ok ? 'deleted' : result.error.code,
    );
    if (!result.ok) throw refusal(result.error, context, this.#logger);
    return result.value;
  }
}
