#!/usr/bin/env node
/**
 * Gera os tipos TypeScript a partir dos contratos OpenAPI.
 *
 * O arquivo YAML e a fonte da verdade (contract-first, doc 03 secao 6).
 * O CI roda este script e falha se o resultado divergir do commitado, para que
 * ninguem altere a API mexendo so no codigo.
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
 * GERADO AUTOMATICAMENTE. Nao edite.
 * Fonte: contracts/openapi/. Regenere com \`make contracts\`.
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
    console.log(`gerado ${moduleName}.ts a partir de ${file}`);
  }

  const barrel =
    HEADER +
    modules.map((m) => `export type * as ${identifierFor(m)} from './${m}.js';`).join('\n') +
    '\n';
  await writeFile(join(outDir, 'index.ts'), barrel, 'utf8');
  console.log(`gerado index.ts com ${modules.length.toString()} modulos`);
}

await main();
