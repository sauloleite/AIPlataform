#!/usr/bin/env node
/**
 * Every `aia_*` name a dashboard or an alert uses is one the platform records.
 *
 * A Grafana panel querying a metric nothing emits does not fail. It draws an
 * empty chart, which is indistinguishable from a quiet hour — and an alert on
 * an absent series simply never fires, which is worse, because the whole point
 * of it was to tell somebody. Renaming a metric in `AIA_METRIC` and forgetting
 * the dashboard is a silent regression in exactly the direction nobody notices.
 *
 * The names here are not what the code declares: Prometheus stores what OTLP
 * ingestion makes of them. The translation below was read off a live Prometheus
 * — dots to underscores, the unit appended to a histogram, `_total` on a
 * counter — and not taken from a specification, because the specification is
 * not what the dashboard has to match.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const ATTRIBUTES = join(ROOT, 'packages/telemetry/src/attributes.ts');
const METRICS = join(ROOT, 'packages/telemetry/src/metrics.ts');
const DASHBOARDS = join(ROOT, 'deploy/grafana/dashboards');
const ALERTING = join(ROOT, 'deploy/grafana/provisioning/alerting');

/** The `NAME: 'value',` pairs inside one `export const X = {...} as const;`. */
function constantsOf(source, block) {
  const match = new RegExp(`export const ${block} = \\{(.*?)\\} as const;`, 's').exec(source);
  if (match === null)
    throw new Error(`${block} not found; this parser no longer understands the file`);
  return [...match[1].matchAll(/^\s*[A-Z_]+: '([^']+)',/gm)].map((entry) => entry[1]);
}

const attributesSource = readFileSync(ATTRIBUTES, 'utf8');
const metricsSource = readFileSync(METRICS, 'utf8');

const metricNames = constantsOf(attributesSource, 'AIA_METRIC');
const attributeNames = [
  ...constantsOf(attributesSource, 'AIA_ATTR'),
  ...constantsOf(attributesSource, 'GEN_AI_ATTR'),
];

/** Which instrument each name is created as, and with what unit. */
function instrumentsOf(source) {
  const kinds = new Map();
  for (const match of source.matchAll(
    /meter\.create(Histogram|Counter|UpDownCounter)\(AIA_METRIC\.([A-Z_]+),\s*\{[^}]*?unit:\s*'([^']*)'/gs,
  )) {
    kinds.set(match[2], { kind: match[1], unit: match[3] });
  }
  return kinds;
}

const byConstant = instrumentsOf(metricsSource);
const constantFor = new Map(
  [...readFileSync(ATTRIBUTES, 'utf8').matchAll(/^\s*([A-Z_]+): '(aia\.[^']+)',/gm)].map((m) => [
    m[2],
    m[1],
  ]),
);

/** Units Prometheus spells out. Anything in braces is an annotation and is dropped. */
const UNIT_SUFFIX = { ms: '_milliseconds', s: '_seconds', By: '_bytes' };

function prometheusNames(name) {
  const base = name.replaceAll('.', '_');
  const instrument = byConstant.get(constantFor.get(name) ?? '');
  if (instrument === undefined) return [];

  const suffix = UNIT_SUFFIX[instrument.unit] ?? '';
  if (instrument.kind === 'Histogram') {
    return ['_bucket', '_count', '_sum'].map((part) => `${base}${suffix}${part}`);
  }
  return [`${base}${suffix}_total`];
}

const allowed = new Set([
  ...metricNames.flatMap(prometheusNames),
  ...attributeNames.map((name) => name.replaceAll('.', '_')),
  // Labels that exist only on metrics, declared in metrics.ts rather than in
  // the span-attribute catalogue.
  ...[...metricsSource.matchAll(/^\s*[A-Z_]+: '([^']+)',/gm)].map((m) => m[1].replaceAll('.', '_')),
]);

function filesIn(directory, extension) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(extension))
    .map((name) => join(directory, name));
}

const problems = [];
for (const file of [...filesIn(DASHBOARDS, '.json'), ...filesIn(ALERTING, '.yaml')]) {
  const source = readFileSync(file, 'utf8');
  const used = new Set([...source.matchAll(/\b(aia_[a-z0-9_]+)\b/g)].map((match) => match[1]));

  for (const name of used) {
    if (!allowed.has(name)) {
      problems.push(
        `${file.replace(`${ROOT}/`, '')}: "${name}" is not a name this platform records`,
      );
    }
  }
}

// A runbook link is the first thing a responder clicks at 03:00, and a 404
// there costs exactly the minutes the alert bought. Two of these pointed at
// files that do not exist -- one of them at a runbook nobody had written.
for (const file of filesIn(ALERTING, '.yaml')) {
  const source = readFileSync(file, 'utf8');
  for (const [, referenced] of source.matchAll(/runbook:\s*(\S+)/g)) {
    if (!existsSync(join(ROOT, referenced))) {
      problems.push(`${file.replace(`${ROOT}/`, '')}: the runbook "${referenced}" does not exist`);
    }
  }
}

// A check that can pass by finding nothing protects nothing.
if (allowed.size === 0) {
  console.error(
    '✗ parsed no metric or attribute names at all; the parser is broken, not the dashboards',
  );
  process.exit(1);
}

if (problems.length > 0) {
  console.error('✗ A dashboard or an alert points at something that is not there:\n');
  for (const problem of problems) console.error(`    ${problem}`);
  console.error(
    '\nA panel on a metric nobody records draws an empty chart, an alert on one never' +
      '\nfires, and a runbook link that 404s costs a responder the minutes the alert' +
      '\nbought. Fix the reference, or create what it points at.',
  );
  process.exit(1);
}

console.log(
  '✓ every aia_* name in the dashboards and alerts is one the platform records,' +
    ' and every runbook they link exists',
);
