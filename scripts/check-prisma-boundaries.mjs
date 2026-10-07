// Persistence boundaries (ADR-0004 decisions 2 and 3, ADR-0008 decision 6; platform
// persistence design, "P", sections 4.2, 9 and PM6). Run by `pnpm boundaries`, so by
// `pnpm verify` and CI; fixtures in apps/api/test/boundary-fixtures/prisma/ are asserted by
// apps/api/test/boundaries.spec.ts.
//
// Schema checks (prisma/schema/*.prisma, read by scripts/prisma-schema.mjs):
//   - <module>.prisma declares models and enums in schema "<module>" only (dashes become
//     underscores); base.prisma declares none; no relation crosses schemas;
//   - every model is scoped (marketId and tenantId) or exempt ("/// @market-scope none:
//     <reason>"), never neither or both; marketId and tenantId come together;
//   - every outbox model (@@map("outbox")) has the same fields;
//   - every @id, @unique, @@id and @@unique of a scoped model contains marketId, except the
//     single-column UUID @id and the ADR-0006 keys of the tables named in EVENT_KEYED_TABLES,
//     which lead with eventId;
//   - every @relation between two scoped models has marketId in both `fields` and
//     `references`, at the same position (PM6).
// Source check, "model to owning module" (P 9), on apps/api/src/modules/<m>/infrastructure/
// and apps/api/src/platform/persistence/: every reference to a Prisma model names a model of
// the file's own module (platform/ owns platform.prisma). A reference is a property of the
// model's client name (`.auditLog`), a `Prisma.<Model>...` name, a name imported from the
// generated client that starts with a model name, or an import from its `models/` folder.
// Named exception: files under platform/persistence/outbox/ reach the models mapped to the
// tables in OUTBOX_TABLES of any module, and those models are reserved to that folder.
//
// Usage: node scripts/check-prisma-boundaries.mjs [schema-dir] [--src <apps/api/src>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { readPrismaSchema } from './prisma-schema.mjs';

/** The tables reserved to platform/persistence/outbox/ (P 9, the named exception). */
const OUTBOX_TABLES = ['outbox', 'inbox'];
/** Tables whose ADR-0006 key leads with the UUIDv7 event id instead of marketId (P 9). */
const EVENT_KEYED_TABLES = ['inbox', 'event_delivery'];
const OUTBOX_FOLDER = 'platform/persistence/outbox/';

const args = process.argv.slice(2);
const srcFlag = args.indexOf('--src');
const srcDir = path.resolve(srcFlag >= 0 ? args[srcFlag + 1] : 'apps/api/src');
const positional = args.filter(
  (arg, index) => !arg.startsWith('--') && args[index - 1] !== '--src',
);
const schemaDir = path.resolve(positional[0] ?? 'prisma/schema');

const { models, enums, problems } = readPrismaSchema(schemaDir);
const byName = new Map(models.map((model) => [model.name, model]));
const isScoped = (model) => model.hasMarketId && model.hasTenantId;

// --- Module schemas (ADR-0004 decision 2).
for (const block of [...models.map((m) => ({ ...m, kind: 'model' })), ...enums]) {
  const expectedSchema = path.basename(block.file, '.prisma').replaceAll('-', '_');
  if (block.file === 'base.prisma') {
    problems.push(`${block.file}: ${block.kind} ${block.name} must live in its module's own file`);
  } else if (block.schema === undefined) {
    problems.push(
      `${block.file}: ${block.kind} ${block.name} has no @@schema("${expectedSchema}")`,
    );
  } else if (block.schema !== expectedSchema) {
    problems.push(
      `${block.file}: ${block.kind} ${block.name} is in schema "${block.schema}", but this file ` +
        `owns "${expectedSchema}"`,
    );
  }
}

for (const model of models) {
  // --- No relation crosses a module schema.
  for (const field of model.fields.filter((f) => f.relation)) {
    const target = byName.get(field.type);
    if (target.schema !== model.schema) {
      problems.push(
        `${model.file}: ${model.name}.${field.name} relates to ${field.type} in schema ` +
          `"${target.schema}". Relations may not cross module schemas; store the id as a plain column.`,
      );
    }
  }

  // --- Scope (P 4.2).
  if (model.hasMarketId !== model.hasTenantId) {
    problems.push(
      `${model.file}: ${model.name} has ${model.hasMarketId ? 'marketId without tenantId' : 'tenantId without marketId'}`,
    );
  } else if (isScoped(model) && model.exemptionReason !== undefined) {
    problems.push(
      `${model.file}: ${model.name} has marketId and tenantId and also an exemption line`,
    );
  } else if (!isScoped(model) && model.exemptionReason === undefined) {
    problems.push(
      `${model.file}: ${model.name} is neither market-scoped (marketId and tenantId) nor exempt ` +
        '("/// @market-scope none: <reason>")',
    );
  }

  // --- Unique keys of a scoped model contain marketId (P 9, PM6).
  if (isScoped(model)) {
    for (const key of model.keys) {
      if (key.fields.includes('marketId')) continue;
      const field = model.fields.find((f) => f.name === key.fields[0]);
      const uuidId =
        key.kind === 'id' &&
        key.single &&
        field?.type === 'String' &&
        field.attributes.some((a) => a.name === 'db.Uuid');
      const eventKey = EVENT_KEYED_TABLES.includes(model.table) && key.fields[0] === 'eventId';
      if (!uuidId && !eventKey) {
        const label = key.single
          ? `@${key.kind} on ${key.fields[0]}`
          : `@@${key.kind}([${key.fields.join(', ')}])`;
        problems.push(`${model.file}: ${model.name} ${label} does not contain marketId`);
      }
    }
  }

  // --- A relation between scoped models carries marketId on both sides, aligned (PM6).
  for (const relation of model.relations) {
    const target = byName.get(relation.target);
    if (!target) continue;
    // An exempt model and a scoped model never relate, in either direction: the guard reads
    // no Market on the exempt side, so a relation would carry rows across Markets.
    if (isScoped(model) !== isScoped(target)) {
      problems.push(
        `${model.file}: ${model.name}.${relation.field} relates ` +
          `${isScoped(model) ? 'a market-scoped' : 'an exempt'} model to ` +
          `${isScoped(target) ? 'the market-scoped' : 'the exempt'} model ${target.name}; ` +
          'exempt and market-scoped models may not relate',
      );
      continue;
    }
    if (!isScoped(model)) continue;
    const from = relation.fields.indexOf('marketId');
    const to = relation.references.indexOf('marketId');
    if (from < 0 || to < 0) {
      problems.push(
        `${model.file}: ${model.name}.${relation.field} relates two market-scoped models without ` +
          'marketId in both fields and references (PM6)',
      );
    } else if (from !== to) {
      problems.push(
        `${model.file}: ${model.name}.${relation.field} pairs marketId with another column ` +
          '(marketId is at different positions in fields and references; PM6)',
      );
    }
  }
}

// --- Every outbox has the same fields (PM1).
const outboxes = models.filter((model) => model.table === 'outbox');
const shape = (model) =>
  JSON.stringify(
    model.fields.map((f) => [f.name, f.type, f.list, f.optional, f.attributes]).sort(),
  );
for (const model of outboxes.slice(1)) {
  if (shape(model) !== shape(outboxes[0])) {
    problems.push(
      `${model.file}: ${model.name} is an outbox whose fields differ from ${outboxes[0].name}`,
    );
  }
}

// --- Model to owning module (P 9).
if (existsSync(srcDir)) problems.push(...checkModelOwnership(srcDir));

if (problems.length > 0) {
  console.error(
    `Prisma boundary violations:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`Prisma boundaries hold (${models.length} model(s) checked).`);

/** The owning module of a source file, or undefined when the rule does not look at it. */
function moduleOfFile(relative) {
  const inModule = /^modules\/([^/]+)\/infrastructure\//.exec(relative);
  if (inModule) return inModule[1];
  if (relative.startsWith('platform/persistence/')) return 'platform';
  return undefined;
}

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|mts|cts)$/.test(entry.name))
    .filter((entry) => !/\.spec\.(ts|mts|cts)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function checkModelOwnership(root) {
  const found = [];
  const byClientProperty = new Map(models.map((model) => [model.clientProperty, model]));
  // Longest name first, so `AuditLogEntry` is not read as `AuditLog` + `Entry`.
  const names = models.map((model) => model.name).sort((a, b) => b.length - a.length);
  const modelOfTypeName = (name) =>
    names.find(
      (model) =>
        name === model || (name.startsWith(model) && /^[A-Z_]/.test(name.slice(model.length))),
    );
  const isGenerated = (specifier) => /(^|\/)generated\/prisma(\/|$)/.test(specifier);

  for (const file of sourceFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const owner = moduleOfFile(relative);
    if (owner === undefined) continue;
    const inOutboxFolder = relative.startsWith(OUTBOX_FOLDER);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    const report = (node, model, how) => {
      const reserved = OUTBOX_TABLES.includes(model.table);
      const allowed = reserved ? inOutboxFolder : model.module === owner;
      if (allowed) return;
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      const why = reserved
        ? `is reserved to ${OUTBOX_FOLDER} (write it through OutboxWriter)`
        : `belongs to module "${model.module}"`;
      found.push(`${relative}:${line + 1}: ${how} names model ${model.name}, which ${why}`);
    };

    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const model = byClientProperty.get(node.name.text);
        if (model) report(node.name, model, `property ".${node.name.text}"`);
        if (ts.isIdentifier(node.expression) && node.expression.text === 'Prisma') {
          const name = modelOfTypeName(node.name.text);
          if (name) report(node.name, byName.get(name), `"Prisma.${node.name.text}"`);
        }
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression)
      ) {
        const model = byClientProperty.get(node.argumentExpression.text);
        if (model)
          report(node.argumentExpression, model, `property ["${node.argumentExpression.text}"]`);
      } else if (
        ts.isQualifiedName(node) &&
        ts.isIdentifier(node.left) &&
        node.left.text === 'Prisma'
      ) {
        const name = modelOfTypeName(node.right.text);
        if (name) report(node.right, byName.get(name), `type "Prisma.${node.right.text}"`);
      } else if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        isGenerated(node.moduleSpecifier.text)
      ) {
        const specifier = node.moduleSpecifier.text;
        const fromModels = /generated\/prisma\/models\/(\w+)$/.exec(specifier);
        if (fromModels && byName.has(fromModels[1])) {
          report(node.moduleSpecifier, byName.get(fromModels[1]), `import "${specifier}"`);
        }
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        const elements = bindings && 'elements' in bindings ? bindings.elements : [];
        for (const element of elements) {
          const imported = (element.propertyName ?? element.name).text;
          const name = modelOfTypeName(imported);
          if (name) report(element, byName.get(name), `import of "${imported}"`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
