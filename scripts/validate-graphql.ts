/**
 * lint de GraphQL (CI): valida que el esquema compile y que TODAS las
 * operaciones del frontend sean válidas contra él. Un cambio de esquema que
 * rompa la UI falla el PR antes del merge.
 */
import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import * as queries from '../frontend/src/queries.ts';

const schema = buildSchema(readFileSync(new URL('../services/graphql-gateway/src/schema.graphql', import.meta.url), 'utf8'));
let failures = 0;
for (const [name, source] of Object.entries(queries)) {
  const errors = validate(schema, parse(source as string));
  if (errors.length) {
    failures++;
    console.error(`✗ ${name}:\n  ${errors.map((e) => e.message).join('\n  ')}`);
  } else {
    console.log(`✓ ${name}`);
  }
}
if (failures) process.exit(1);
console.log(`Esquema válido y ${Object.keys(queries).length} operaciones del frontend compatibles.`);
