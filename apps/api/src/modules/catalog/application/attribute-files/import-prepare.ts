import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { readImportFile, type FileRefusal } from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { PLATFORM_IMPORT_CHECK_LIMITS } from '../../domain/rate-limits';
import { ATTRIBUTE_LOAD_MAX, marketLocalesOf } from '../attributes/attribute-admin-views';
import {
  reserveForAccount,
  type ReserveDependencies,
  type ReserveFailure,
} from '../platform-import/reserve';
import { isActingAsSession } from '../acting-as';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ImportFileParsers } from '../ports/import-file-parsers';
import { readColumns, type AttributeFileKind, type ColumnsRefusal } from './file-layout';
import { planAttributes, planValues, type ImportPlan } from './import-plan';

// What the check and the run of an attribute import share (attributes package A9): the request is
// typed, the size of the text is checked before it is decoded, the account's upload count is spent
// before the file is read, then the file is read within the limits, the columns are mapped and the
// rows are planned against the attributes of the Market. Nothing is stored: the run reads the file
// again, so what it applies is exactly what the check showed (the SHA-256 ties the two together).

export interface PrepareDependencies extends ReserveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
  readonly importParsers: ImportFileParsers;
}

export type PrepareFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | ReserveFailure
  | FileRefusal
  | ColumnsRefusal
  | { readonly code: 'import.too-many-attributes' }
  | { readonly code: 'import.too-many-writes'; readonly max: number }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface Prepared {
  readonly kind: AttributeFileKind;
  /** Hex SHA-256 of the uploaded bytes. */
  readonly fileSha256: string;
  /** Hex SHA-256 of what the plan writes (the attributes and their versions): the run applies only that. */
  readonly planSha256: string;
  readonly plan: ImportPlan;
  readonly ignoredColumns: readonly string[];
}

/** Attributes (or attribute revisions) one file may write; a longer file is split. */
export const IMPORT_MAX_WRITES = 500;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The base64 text of a file at the size limit, plus its padding. */
const MAX_BASE64_LENGTH = Math.ceil((IMPORT_LIMITS.fileBytes * 4) / 3) + 4;

export async function prepareImport(
  deps: PrepareDependencies,
  context: CallContext,
  input: { readonly data?: unknown; readonly fileName?: unknown },
): Promise<Result<Prepared, PrepareFailure>> {
  const { actor, market } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  if (isActingAsSession(actor)) return err({ code: 'access.denied' });
  const fail = (path: string, code: string): Result<never, PrepareFailure> =>
    err({ code: 'validation.failed', fields: [{ path, code }] });
  if (typeof input.data !== 'string' || input.data.length === 0) return fail('data', 'required');
  if (input.fileName !== undefined && typeof input.fileName !== 'string') {
    return fail('fileName', 'type');
  }
  if (input.data.length > MAX_BASE64_LENGTH) {
    return err({ code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes });
  }
  if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) return fail('data', 'format');

  const throttled = await reserveForAccount(
    deps,
    context,
    PLATFORM_IMPORT_CHECK_LIMITS,
    actor.accountId,
  );
  if (throttled !== null) return err(throttled);

  const bytes = Buffer.from(input.data, 'base64');
  const table = await readImportFile(bytes, IMPORT_LIMITS, deps.importParsers);
  if (!table.ok) return table;

  let locales: { readonly default: string; readonly supported: readonly string[] };
  try {
    locales = marketLocalesOf(deps.policy.locales(market));
  } catch {
    return err({ code: 'access.unavailable' });
  }
  const columns = readColumns(table.value.header, locales.supported);
  if (!columns.ok) return err(columns.error);

  let definitions: Awaited<ReturnType<AttributeAdminReader['definitions']>>;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.attributeAdminReader.definitions(market, ATTRIBUTE_LOAD_MAX)),
      { readOnly: true },
    );
    if (!read.ok || read.value.length >= ATTRIBUTE_LOAD_MAX)
      return err({ code: 'access.unavailable' });
    definitions = read.value;
  } catch {
    return err({ code: 'access.unavailable' });
  }
  const env = { locales, definitions };
  const plan =
    columns.value.kind === 'attributes'
      ? planAttributes(table.value.rows, columns.value, env)
      : planValues(table.value.rows, columns.value, env);
  if (plan.writes.length > IMPORT_MAX_WRITES) {
    return err({ code: 'import.too-many-writes', max: IMPORT_MAX_WRITES });
  }
  // The Market's attributes are read up to ATTRIBUTE_LOAD_MAX; a file may not push it past that.
  const creates = plan.writes.filter((write) => write.kind === 'create').length;
  if (definitions.length + creates >= ATTRIBUTE_LOAD_MAX) {
    return err({ code: 'import.too-many-attributes' });
  }
  const planSha256 = createHash('sha256')
    .update(
      JSON.stringify(
        plan.writes.map((write) =>
          write.kind === 'edit'
            ? ['edit', write.code, write.attributeId, write.version]
            : ['create', write.code],
        ),
      ),
    )
    .digest('hex');
  return ok({
    kind: columns.value.kind,
    planSha256,
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    plan,
    ignoredColumns: columns.value.ignored,
  });
}
