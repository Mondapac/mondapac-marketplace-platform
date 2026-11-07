import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac/shared-kernel';
import type { Request, Response } from 'express';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { AdminVariantIssueCounts } from '../application/use-cases/admin-variant-issue-counts.use-case';
import { AdminVariantTypeGet } from '../application/use-cases/admin-variant-type-get.use-case';
import { AdminVariantTypesList } from '../application/use-cases/admin-variant-types-list.use-case';
import {
  AdminVariantsExport,
  VARIANTS_EXPORT_MAX_ROWS,
} from '../application/use-cases/admin-variants-export.use-case';
import {
  AdminVariantsList,
  VARIANT_ISSUES,
} from '../application/use-cases/admin-variants-list.use-case';
import { VariantTypeSettingsEdit } from '../application/use-cases/variant-type-settings-edit.use-case';
import { closedBody, pageQuery, refusalWith, type Refusal } from './http-answers';
import { ApiErrorBody } from './platform-product.dto';
import {
  AdminVariantIssueCountsDto,
  AdminVariantListDto,
  VariantTypeDetailBody,
  VariantTypeListDto,
  VariantTypeSettingsBody,
  VariantTypeSettingsRequest,
} from './variant-admin.dto';
import { writeChunks } from './write-chunks';

/**
 * The HTTP status of each refusal of the admin Variants routes (variants V6). A malformed query or
 * body is 400; an unknown id is 404; a stale version is 409; content the rules refuse (an unknown
 * option, a colour, a help text, a claim word, a locale the claim check cannot read) is 422; an
 * export over the cap is 413; a missing dependency or an unreadable claim vocabulary is 503.
 */
export const VARIANT_ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'variant-type.not-found': 404,
  'variant-type.stale': 409,
  'variant-type.invalid': 422,
  'attribute.claim-word': 422,
  'attribute.locale-uncheckable': 422,
  'batch.too-large': 413,
  'access.unavailable': 503,
  'claim-text.check-unavailable': 503,
});

const refusal = (error: Refusal, response: Response, context?: CallContext): HttpException =>
  refusalWith(
    VARIANT_ADMIN_STATUS,
    error,
    response,
    context,
    'catalog.variant-admin-unmapped-refusal',
  );

const UNAUTHORIZED = 'session.invalid (the cookie is cleared) or access.unauthenticated';
const NEEDS = 'Needs catalog.variant.view.';
const EDITS =
  'Needs catalog.variant-type.edit and catalog.attribute.edit (both protected); refused in an ' +
  'acting-as session.';
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const TYPE_PARAM = { name: 'variantTypeId', description: 'The attribute definition. A UUID v7.' };
const FILTER_DOC =
  '`q` searches the product name (default locale), the product or variant code, GTIN digits and ' +
  'seller SKUs; `typeCode` keeps one variant type; `issue` is one of ' +
  `${VARIANT_ISSUES.join(', ')}.`;

/**
 * The admin Catalogue > Variants page (variants V6; plan section 9): the Variant types tab (the
 * list, one type's details and its display settings) and the Variants tab (the list with its
 * issue filters, the issue counts and the export). Thin adapters over one use case each.
 */
@ApiTags('catalog')
@RoutePopulation('admin')
@Controller('catalog/admin')
export class VariantAdminController {
  readonly #logger = new Logger('VariantAdminController');

  constructor(
    private readonly listTypes: AdminVariantTypesList,
    private readonly getType: AdminVariantTypeGet,
    private readonly editSettings: VariantTypeSettingsEdit,
    private readonly listVariants: AdminVariantsList,
    private readonly countIssues: AdminVariantIssueCounts,
    private readonly exportVariants: AdminVariantsExport,
  ) {}

  @Get('variant-types')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List variant types',
    description:
      `${NEEDS} Every attribute that is a variant option (not archived), by code, with its ` +
      'display style, active options, live products and variants, the feature sets that offer it ' +
      'and the language completeness of its name and labels.',
  })
  @ApiOkResponse({ type: VariantTypeListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async types(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<VariantTypeListDto> {
    const result = await this.listTypes.execute(context, { ...query });
    return this.#settle(
      'catalog.admin-variant-types-list',
      context,
      result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as VariantTypeListDto)
        : refusal(result.error, response, context),
    );
  }

  @Get('variant-types/:variantTypeId')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Read a variant type',
    description:
      `${NEEDS} The settings and the options in the order buyers see them, each with its swatch ` +
      'and live product count. Names and labels are edited in Attributes.',
  })
  @ApiParam(TYPE_PARAM)
  @ApiOkResponse({ type: VariantTypeDetailBody })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'variant-type.not-found' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async type(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('variantTypeId') variantTypeId: string,
  ): Promise<VariantTypeDetailBody> {
    const result = await this.getType.execute(context, { id: variantTypeId });
    return this.#settle(
      'catalog.admin-variant-type-get',
      context,
      result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as VariantTypeDetailBody)
        : refusal(result.error, response, context),
    );
  }

  @Put('variant-types/:variantTypeId/settings')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Save how buyers choose a variant type',
    description:
      `${EDITS} The whole settings and the version read (0 while the defaults apply; a later ` +
      'one is variant-type.stale: reload). Saved as the next revision. A swatch names an option ' +
      'of the type and a colour #RRGGBB; the seller help is one plain sentence per locale and ' +
      'passes the claim-text check.',
  })
  @ApiParam(TYPE_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: VariantTypeSettingsRequest })
  @ApiOkResponse({ type: VariantTypeSettingsBody })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied or request.csrf' })
  @ApiNotFoundResponse({ type: ApiErrorBody, description: 'variant-type.not-found' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'variant-type.stale' })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorBody,
    description:
      'variant-type.invalid, attribute.claim-word or attribute.locale-uncheckable (details.fields)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'access.unavailable or claim-text.check-unavailable',
  })
  async saveSettings(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('variantTypeId') variantTypeId: string,
    @Body() body: unknown,
  ): Promise<VariantTypeSettingsBody> {
    const input = closedBody(
      request,
      body,
      ['version', 'displayStyle', 'optionOrder'],
      ['swatches', 'sellerHelp'],
    );
    let outcome: VariantTypeSettingsBody | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.editSettings.execute(context, { ...input, id: variantTypeId });
      outcome = result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as VariantTypeSettingsBody)
        : refusal(result.error, response, context);
    }
    return this.#settle('catalog.variant-type-settings-edit', context, outcome);
  }

  @Get('variants')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'List variants',
    description:
      `${NEEDS} The variants of every live product of the Market (paused included), newest ` +
      `first, with their issues. ${FILTER_DOC} Paged by \`after\` (nextAfter of the last page) ` +
      'and `limit` (1 to 100, default 25).',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'typeCode', required: false })
  @ApiQuery({ name: 'issue', required: false, enum: VARIANT_ISSUES })
  @ApiQuery({ name: 'after', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: AdminVariantListDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async variants(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<AdminVariantListDto> {
    const result = await this.listVariants.execute(context, pageQuery(query));
    return this.#settle(
      'catalog.admin-variants-list',
      context,
      result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AdminVariantListDto)
        : refusal(result.error, response, context),
    );
  }

  @Get('variants/issue-counts')
  @Header('Cache-Control', 'no-store')
  @ReadsSession()
  @ApiOperation({
    summary: 'Count the variants of each issue filter',
    description: `${NEEDS} For all variant types or the one \`typeCode\` names.`,
  })
  @ApiQuery({ name: 'typeCode', required: false })
  @ApiOkResponse({ type: AdminVariantIssueCountsDto })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async issueCounts(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<AdminVariantIssueCountsDto> {
    const result = await this.countIssues.execute(context, { ...query });
    return this.#settle(
      'catalog.admin-variant-issue-counts',
      context,
      result.ok
        ? (JSON.parse(JSON.stringify(result.value)) as AdminVariantIssueCountsDto)
        : refusal(result.error, response, context),
    );
  }

  @Get('variants/export')
  @ReadsSession()
  @ApiOperation({
    summary: 'Export the variants of the list as a file',
    description:
      `${NEEDS} ${FILTER_DOC} \`format\` is csv (the default) or xlsx, with the same columns: ` +
      'product_code, variant_code, product_type, one option[<attribute code>] per axis of the ' +
      'exported products, gtin, offer_count, then Product, Variant, Status, Sellers selling, ' +
      'Issues. At most ' +
      `${VARIANTS_EXPORT_MAX_ROWS} variants; more is batch.too-large. The file streams as an ` +
      'attachment. CSV: a text cell that starts with = + - @ is written with a leading quote. ' +
      'XLSX: every cell is a string value, never a formula.',
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv', 'xlsx'] })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'typeCode', required: false })
  @ApiQuery({ name: 'issue', required: false, enum: VARIANT_ISSUES })
  @ApiOkResponse({
    description:
      'text/csv; charset=utf-8 (variants-<date>.csv) or ' +
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (variants-<date>.xlsx), as an attachment',
  })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: UNAUTHORIZED })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiPayloadTooLargeResponse({ type: ApiErrorBody, description: 'batch.too-large' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async download(
    @Call() context: CallContext,
    @Res() response: Response,
    @Query() query: Record<string, unknown>,
  ): Promise<void> {
    const result = await this.exportVariants.execute(context, { ...query });
    if (!result.ok) {
      const error = refusal(result.error, response, context);
      this.#log('catalog.admin-variants-export', context, error);
      response
        .status(error.getStatus())
        .setHeader('Cache-Control', 'no-store')
        .json(error.getResponse());
      return;
    }
    const { filename, contentType, chunks } = result.value;
    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await writeChunks(response, chunks);
      this.#log('catalog.admin-variants-export', context, null);
    } catch {
      // The status line is gone: end the connection, so the client sees a failed download.
      this.#logger.warn({
        msg: 'catalog.admin-variants-export',
        code: 'stream-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      response.destroy();
    }
  }

  #log(msg: string, context: CallContext, outcome: HttpException | null): void {
    const failed = outcome !== null && outcome.getStatus() >= 500;
    this.#logger[failed ? 'warn' : 'log']({
      msg,
      outcome: outcome === null ? 'ok' : (outcome.getResponse() as { code: string }).code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }

  #settle<T extends object>(msg: string, context: CallContext, outcome: T | HttpException): T {
    this.#log(msg, context, outcome instanceof HttpException ? outcome : null);
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
