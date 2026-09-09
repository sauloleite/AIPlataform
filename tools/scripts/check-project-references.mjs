#!/usr/bin/env node
/**
 * Every `@aia/*` dependency a package declares must also be a TypeScript
 * project reference in its build config.
 *
 * Why this exists: `packages/auth` gained a dependency on `@aia/contracts`
 * (ADR-027) and nothing failed. The root `tsc --build tsconfig.build.json`
 * builds every project listed there, so `@aia/contracts` happened to be
 * compiled before anything needed it, and `make check` was green. The image
 * build is not: `deploy/docker/node.Dockerfile` runs
 * `tsc --build apps/<service>/tsconfig.build.json`, which follows REFERENCES
 * and nothing else, so it stopped at "Cannot find module '@aia/contracts'"
 * after ten minutes of build.
 *
 * A reference is how one project says it needs another. A dependency without
 * one compiles by luck, in the order that happens to be right locally.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const WORKSPACES = ['packages', 'apps'];

/** tsconfig allows comments and trailing commas; JSON.parse does not. */
function readTsConfig(path) {
  const raw = readFileSync(path, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
}

/** The references a config declares, plus everything it inherits. */
function referencedProjects(configPath, seen = new Set()) {
  if (seen.has(configPath)) return [];
  seen.add(configPath);

  const config = readTsConfig(configPath);
  const here = dirname(configPath);
  const own = (config.references ?? []).map((reference) =>
    relative(ROOT, resolve(here, reference.path)),
  );

  if (typeof config.extends !== 'string') return own;
  const parent = resolve(here, config.extends);
  return existsSync(parent) ? [...own, ...referencedProjects(parent, seen)] : own;
}

const problems = [];

for (const workspace of WORKSPACES) {
  for (const name of readdirSync(join(ROOT, workspace))) {
    const packagePath = join(ROOT, workspace, name, 'package.json');
    const configPath = join(ROOT, workspace, name, 'tsconfig.build.json');
    if (!existsSync(packagePath) || !existsSync(configPath)) continue;

    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    const declared = Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
      dependency.startsWith('@aia/'),
    );
    const referenced = referencedProjects(configPath);

    for (const dependency of declared) {
      const target = `packages/${dependency.slice('@aia/'.length)}/tsconfig.build.json`;
      if (!referenced.includes(target)) {
        problems.push(
          `${workspace}/${name}: depends on ${dependency} and does not reference ${target}`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('✗ A declared dependency is missing its project reference:\n');
  for (const problem of problems) console.error(`    ${problem}`);
  console.error(
    '\nAdd it to references in tsconfig.build.json. Without it the package compiles' +
      '\nonly when something else happens to build the dependency first, which is true' +
      '\nat the repository root and false in every service image.',
  );
  process.exit(1);
}

console.log('✓ every @aia dependency is a project reference');
