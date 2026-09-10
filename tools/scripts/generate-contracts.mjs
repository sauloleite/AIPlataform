#!/usr/bin/env node
/**
 * Generates the TypeScript types from the OpenAPI contracts.
 *
 * The YAML file is the source of truth (contract-first, reference doc 03 §6).
 * CI runs this script and fails if the result differs from what was committed,
 * so nobody changes the API by touching only the code.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapiDir = join(root, 'contracts/openapi');
const outDir = join(root, 'packages/contracts/src/generated');
const pythonOutDir = join(root, 'python/aia_contracts/src/aia_contracts/generated');

const HEADER = `/**
 * AUTOMATICALLY GENERATED. Do not edit.
 * Source: contracts/openapi/. Regenerate with \`make contracts\`.
 */
`;

const PYTHON_HEADER = `"""AUTOMATICALLY GENERATED. Do not edit.

Source: contracts/openapi/_shared.yaml. Regenerate with \`make contracts\`.
"""
`;

/**
 * The data-zone rule, emitted into both languages from the contract.
 *
 * `openapi-typescript` produces TYPES; this is a runtime value, so it needs its
 * own emission. It earns that because the rule -- which zones a classification
 * may reach, ADR-010 -- was written out four times, in packages/auth,
 * python/aia_auth, aia-governance's domain and the console's. Four copies of the
 * rule that decides whether restricted data may leave the machine is four
 * chances to disagree, and nothing compared them.
 */
async function generateDataZones() {
  const shared = parseYaml(await readFile(join(openapiDir, '_shared.yaml'), 'utf8'));
  const classification = shared.components.schemas.DataClassification;
  const zones = shared.components.schemas.DataZone.enum;
  const maxZones = classification['x-max-data-zones'];

  if (maxZones === undefined) {
    throw new Error('_shared.yaml: DataClassification has no x-max-data-zones');
  }
  for (const level of classification.enum) {
    if (maxZones[level] === undefined) {
      throw new Error(`_shared.yaml: x-max-data-zones has no entry for "${level}"`);
    }
  }

  const ts =
    HEADER +
    `\nexport const DATA_ZONES = ${JSON.stringify(zones)} as const;\n` +
    `export type DataZone = (typeof DATA_ZONES)[number];\n\n` +
    `export const CLASSIFICATIONS = ${JSON.stringify(classification.enum)} as const;\n` +
    `export type Classification = (typeof CLASSIFICATIONS)[number];\n\n` +
    `/** ADR-010: the most a classification may reach. A policy narrows, never widens. */\n` +
    `export const MAX_ZONES_BY_CLASSIFICATION: Readonly<Record<Classification, readonly DataZone[]>> =\n` +
    `  ${JSON.stringify(maxZones, null, 2).replace(/\n/g, '\n  ')} as const;\n`;
  await writeFile(join(outDir, 'data-zones.ts'), ts, 'utf8');

  const pyDict = (value) =>
    Object.entries(value)
      .map(
        ([key, list]) =>
          `    ${JSON.stringify(key)}: (${list.map((z) => `${JSON.stringify(z)}`).join(', ')},),`,
      )
      .join('\n');

  const py =
    PYTHON_HEADER +
    `\nfrom typing import Final\n\n` +
    `DATA_ZONES: Final[tuple[str, ...]] = (${zones.map((z) => JSON.stringify(z)).join(', ')},)\n\n` +
    `CLASSIFICATIONS: Final[tuple[str, ...]] = (${classification.enum.map((c) => JSON.stringify(c)).join(', ')},)\n\n` +
    `#: ADR-010: the most a classification may reach. A policy narrows, never widens.\n` +
    `MAX_ZONES_BY_CLASSIFICATION: Final[dict[str, tuple[str, ...]]] = {\n${pyDict(maxZones)}\n}\n`;
  await mkdir(pythonOutDir, { recursive: true });
  await writeFile(join(pythonOutDir, '__init__.py'), PYTHON_HEADER, 'utf8');
  await writeFile(join(pythonOutDir, 'data_zones.py'), py, 'utf8');

  console.log('generated data-zones.ts and data_zones.py from _shared.yaml');
}

function moduleNameFor(file) {
  // inference-router.v1.yaml -> inference-router
  return file.replace(/\.v\d+\.yaml$/, '');
}

function identifierFor(moduleName) {
  return moduleName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const files = (await readdir(openapiDir))
    .filter((file) => file.endsWith('.yaml') && !file.startsWith('_'))
    .sort();

  const modules = [];

  for (const file of files) {
    const moduleName = moduleNameFor(file);
    const target = join(outDir, `${moduleName}.ts`);

    const { stdout } = await execFileAsync(
      'node',
      [
        join(root, 'node_modules/openapi-typescript/bin/cli.js'),
        join(openapiDir, file),
        '--empty-objects-unknown',
        '--root-types',
      ],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    );

    await writeFile(target, HEADER + stdout, 'utf8');
    modules.push(moduleName);
    console.log(`generated ${moduleName}.ts from ${file}`);
  }

  const barrel =
    HEADER +
    modules.map((m) => `export type * as ${identifierFor(m)} from './${m}.js';`).join('\n') +
    '\n';
  await writeFile(join(outDir, 'index.ts'), barrel, 'utf8');
  console.log(`generated index.ts with ${modules.length.toString()} modules`);

  await generateDataZones();
}

await main();
