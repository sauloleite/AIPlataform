#!/usr/bin/env node
/**
 * Generates the TypeScript types from the OpenAPI contracts.
 *
 * The YAML file is the source of truth (contract-first, reference doc 03 §6).
 * CI runs this script and fails if the result differs from what was committed,
 * so nobody changes the API by touching only the code.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const openapiDir = join(root, 'contracts/openapi');
const outDir = join(root, 'packages/contracts/src/generated');

const HEADER = `/**
 * AUTOMATICALLY GENERATED. Do not edit.
 * Source: contracts/openapi/. Regenerate with \`make contracts\`.
 */
`;

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
}

await main();
