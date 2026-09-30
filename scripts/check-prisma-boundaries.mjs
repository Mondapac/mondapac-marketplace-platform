// Persistence boundaries (ADR-0004 decisions 2 and 3): every module owns one Prisma file
// and one PostgreSQL schema, and no relation crosses schemas.
//   - prisma/schema/<module>.prisma may only declare models and enums in schema "<module>"
//     (dashes become underscores: commission-payouts.prisma -> "commission_payouts");
//   - a model field may only reference a model in the same schema. Cross-module references
//     are plain id columns.
//
// Usage: node scripts/check-prisma-boundaries.mjs [schema-dir]
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const schemaDir = path.resolve(process.argv[2] ?? 'prisma/schema');
const problems = [];
const models = new Map(); // model name -> { schema, file, body }

for (const file of readdirSync(schemaDir)
  .filter((name) => name.endsWith('.prisma'))
  .sort()) {
  const expectedSchema = path.basename(file, '.prisma').replaceAll('-', '_');
  const source = readFileSync(path.join(schemaDir, file), 'utf8').replace(/\/\/.*$/gm, '');

  for (const match of source.matchAll(/^(model|enum)\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const [, kind, name, body] = match;
    const schema = /@@schema\("([^"]+)"\)/.exec(body)?.[1];
    if (file === 'base.prisma') {
      problems.push(`${file}: ${kind} ${name} must live in its module's own file`);
    } else if (schema === undefined) {
      problems.push(`${file}: ${kind} ${name} has no @@schema("${expectedSchema}")`);
    } else if (schema !== expectedSchema) {
      problems.push(
        `${file}: ${kind} ${name} is in schema "${schema}", but this file owns "${expectedSchema}"`,
      );
    }
    if (kind === 'model') models.set(name, { schema, file, body });
  }
}

for (const [name, model] of models) {
  for (const line of model.body.split('\n')) {
    const field = /^\s*(\w+)\s+(\w+)(\[\]|\?)?(\s|$)/.exec(line);
    const target = field && models.get(field[2]);
    if (target && target.schema !== model.schema) {
      problems.push(
        `${model.file}: ${name}.${field[1]} relates to ${field[2]} in schema "${target.schema}". ` +
          'Relations may not cross module schemas; store the id as a plain column.',
      );
    }
  }
}

if (problems.length > 0) {
  console.error(
    `Prisma boundary violations:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`Prisma boundaries hold (${models.size} model(s) checked).`);
