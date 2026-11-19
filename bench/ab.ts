import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  abManifest,
  MANIFEST_V2_PATH,
  manifestSha256,
  readManifest,
  readManifestV2,
  type Manifest,
  type ManifestV2,
} from './manifest.ts';
import { abTargetKind, parseShard, renderAb } from './report.ts';
import {
  buildCommit,
  commitOf,
  refuseNodeEnvironment,
  requestedPinning,
  ROOT,
  runV2,
  type Pinning,
  type RunV2Options,
  sourceIdentity,
  treeSha256,
  WORK_V2,
} from './run.ts';

// A/B of two commits for an optimisation decision (method v2). Each commit is exported and built into its own directory, `a` and
// `b`, siblings of equal depth and name length. Both arms run under this
// checkout's harness and packages, so only the bundle differs. Every round runs
// one fresh pinned process per arm and case in a new random order; the report
// gives the B/A interval per case and the keep/reject line. The
// raw records go to work/bench-v2/ab/<id>/ab.jsonl and the report to report.md there.
// Exit codes: 0 keep or reject, 1 no decision (or a dry run that was refused by the
// budget), 2 refused before anything was built (existing id, dirty tree, wrong Node,
// unknown case or target).
//
// --lane S1: targets and the rule's other cases are S1 cases of
// class additional, and no primary case is run; the rule reads "every S1 case of the
// same size as a target" for "every other primary case". --lane W1: the W1 cases only,
// which are primary inside the W1 manifest. Without --lane nothing changes.
//
//   taskset -c <runner cpu> node bench/ab.ts --id <name> --a <commit> --b <commit> \
//     --targets <case,...> --pin-cpu <cpu> [--lane S1|W1] [--seed <n>] [--cases <case,...>]
//     [--processes <n>] [--budget <minutes>] [--dry-run]

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Exit code of a run that was refused before anything was built or measured. */
export const REFUSED = 2;

/**
 * Everything that must hold before an A/B run builds or measures anything; each
 * string is a reason to refuse. An existing run directory is never reused: its
 * report.md would otherwise survive a failed rerun and read as this run's decision.
 */
export function abPreflight(check: {
  id: string;
  /** work/bench-v2/ab/<id> already exists. */
  exists: boolean;
  /** The harness tree differs from its commit. */
  dirty: boolean;
  node: string;
  requiredNode: string;
  /**
   * All case ids of the manifest, and the cases a target may be: the primary ones,
   * or with --lane that lane's (abCases).
   */
  known: readonly string[];
  primary: readonly string[];
  cases: readonly string[];
  targets: readonly string[];
  lane?: string | undefined;
}): string[] {
  const issues: string[] = [];
  if (!/^[A-Za-z0-9._-]+$/.test(check.id))
    issues.push(`--id ${check.id} must use only letters, digits, '.', '_' and '-'`);
  if (check.exists)
    issues.push(`work/bench-v2/ab/${check.id} already exists: choose a new --id or remove it`);
  if (check.dirty) issues.push('the harness working tree differs from its commit');
  if (check.node !== `v${check.requiredNode}`)
    issues.push(`A/B runs require Node ${check.requiredNode}; this is ${check.node}`);
  const { lane } = check;
  if (lane !== undefined && lane !== 'S1' && lane !== 'W1') {
    issues.push(`unknown --lane ${lane} (S1 or W1)`);
    return issues;
  }
  const eligible = `${abTargetKind(lane)}${lane === undefined ? '' : ` (--lane ${lane})`}`;
  for (const c of check.cases) {
    if (check.known.includes(c)) continue;
    issues.push(
      lane === undefined
        ? `unknown case ${c} in --cases`
        : `case ${c} in --cases is not a${lane === 'S1' ? 'n' : ''} ${lane} case (--lane ${lane})`,
    );
  }
  for (const t of check.targets) {
    if (!check.primary.includes(t)) issues.push(`target ${t} is not ${eligible}`);
    else if (!check.cases.includes(t))
      issues.push(`target ${t} is not among the cases of this run`);
  }
  return issues;
}

/**
 * The manifest an A/B run reads and its case lists: every case it knows, the cases a
 * target may be, and the default --cases for the given targets (every case a target
 * may be; with --lane S1 those of the targets' sizes, which the rule needs).
 */
export function abCases(
  lane: string | undefined,
  targets: readonly string[],
  base: Manifest = readManifest(),
  v2: ManifestV2 = readManifestV2(),
) {
  const manifest = abManifest(lane, base, v2);
  const eligible = manifest.cases.filter((c) =>
    lane === 'S1' ? c.lane === 'S1' && c.class === 'additional' : c.class === 'primary',
  );
  const sizes = new Set(eligible.filter((c) => targets.includes(c.id)).map((c) => c.targetBytes));
  return {
    manifest,
    known: manifest.cases.map((c) => c.id),
    primary: eligible.map((c) => c.id),
    cases: eligible
      .filter((c) => lane !== 'S1' || sizes.size === 0 || sizes.has(c.targetBytes))
      .map((c) => c.id),
  };
}

/** One arm of an A/B run: a commit built into its own directory. */
export interface AbArm {
  commit: string;
  distSha256: string;
  dir: string;
  distDir: string;
  entry: string;
}

/**
 * The run of an A/B (runV2's options): arms a and b on every case of the run, each a
 * fresh pinned process per round, no memory phase; the start record names the lane,
 * both arms and the targets.
 */
export function abRunOptions(o: {
  id: string;
  lane: string | undefined;
  manifest: Manifest;
  v2: ManifestV2;
  caseIds: readonly string[];
  targets: readonly string[];
  seed: number;
  processes: number;
  budgetMinutes: number;
  dryRunOnly: boolean;
  pinning: Pinning | null;
  outFile: string;
  copies: string[];
  a: AbArm;
  b: AbArm;
}): RunV2Options {
  const { manifest, a, b } = o;
  const cases = manifest.cases.filter((c) => o.caseIds.includes(c.id));
  const pairs = cases.flatMap((c) =>
    ['a', 'b'].map((impl) => ({ impl, case: c.id, expect: 'measure' as const })),
  );
  return {
    kind: 'ab',
    campaignId: o.id,
    shardId: 'ab',
    seed: o.seed,
    outFile: o.outFile,
    manifest,
    v2: o.v2,
    cases,
    pairs,
    campaignShards: { ab: pairs },
    memoryPairs: [],
    phase: 'timing',
    processes: o.processes,
    memoryProcesses: 0,
    pinning: o.pinning,
    budgetMinutes: o.budgetMinutes,
    dryRunOnly: o.dryRunOnly,
    copies: o.copies,
    entries: { a: a.entry, b: b.entry },
    entrySha256: { a: sha256(a.entry), b: sha256(b.entry) },
    identities: { a, b },
    start: {
      ...(o.lane === undefined ? {} : { lane: o.lane }),
      ab: {
        a: { commit: a.commit, distSha256: a.distSha256, dir: a.dir },
        b: { commit: b.commit, distSha256: b.distSha256, dir: b.dir },
        targets: o.targets,
      },
    },
    unchanged: () =>
      treeSha256(a.distDir) === a.distSha256 && treeSha256(b.distDir) === b.distSha256,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      id: { type: 'string' },
      a: { type: 'string' },
      b: { type: 'string' },
      targets: { type: 'string', default: '' },
      cases: { type: 'string' },
      'pin-cpu': { type: 'string' },
      seed: { type: 'string' },
      processes: { type: 'string' },
      budget: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      lane: { type: 'string' },
    },
  });
  if (!values.id || !values.a || !values.b)
    throw new Error(
      'usage: node bench/ab.ts --id <name> --a <commit> --b <commit> --targets <case,...> --pin-cpu <cpu>',
    );
  const v2 = readManifestV2();
  const base = join(WORK_V2, 'ab', values.id);
  const targets = values.targets.split(',').filter(Boolean);
  const { lane } = values;
  const lists = abCases(lane === 'S1' || lane === 'W1' ? lane : undefined, targets);
  const { manifest } = lists;
  const caseIds = values.cases?.split(',') ?? lists.cases;
  const refusals = abPreflight({
    id: values.id,
    exists: existsSync(base),
    dirty: sourceIdentity().dirty,
    node: process.version,
    requiredNode: manifest.runtime.node,
    known: lists.known,
    primary: lists.primary,
    cases: caseIds,
    targets,
    lane,
  });
  if (refusals.length > 0) {
    process.stderr.write(`refused, nothing was built or measured:\n- ${refusals.join('\n- ')}\n`);
    process.exitCode = REFUSED;
    return;
  }
  refuseNodeEnvironment();
  const pinning = requestedPinning(v2, 'ab', values['pin-cpu']);
  const seed = values.seed === undefined ? randomInt(2 ** 32) : Number(values.seed);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed >= 2 ** 32)
    throw new Error('--seed must be an integer in [0, 2^32)');
  // Both revisions are resolved before the first build creates the run directory.
  const commits = { a: commitOf(values.a), b: commitOf(values.b) };
  const arm = (name: 'a' | 'b') => {
    const commit = commits[name];
    const dir = join(base, name);
    const distSha256 = buildCommit(commit, dir, v2);
    const distDir = join(realpathSync(dir), v2.candidate.distDir);
    return {
      commit,
      distSha256,
      dir: realpathSync(dir),
      distDir,
      entry: join(distDir, v2.candidate.entry),
    };
  };
  const outFile = join(base, 'ab.jsonl');
  const code = await runV2(
    abRunOptions({
      id: values.id,
      lane,
      manifest,
      v2,
      caseIds,
      targets,
      seed,
      processes: Number(values.processes ?? v2.measurement.processes),
      budgetMinutes: Number(values.budget ?? v2.budget.defaultMinutes),
      dryRunOnly: values['dry-run'],
      pinning,
      outFile,
      copies: [realpathSync(ROOT)],
      a: arm('a'),
      b: arm('b'),
    }),
  );
  process.exitCode = code;
  if (values['dry-run']) return;
  const report = renderAb(
    manifest,
    v2,
    { manifestSha256: manifestSha256(), manifestV2Sha256: sha256(MANIFEST_V2_PATH) },
    parseShard(readFileSync(outFile, 'utf8'), outFile),
  );
  writeFileSync(join(base, 'report.md'), report.text);
  process.stdout.write(report.text);
  if (report.decision === null) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
