/**
 * The runtime floor, kept in step with `engines.node` in package.json.
 *
 * It is not a preference. Native addons we depend on are prebuilt against
 * node-api version 10 (better-sqlite3 compiles with `NAPI_VERSION=10`), which
 * first exists in Node 22. An older runtime still loads such a binary — every
 * symbol it imports has been there since node-api 8 — but runs its finalizers
 * under the pre-10 rules, inside garbage collection, where the addon is not
 * allowed to call back into node-api. The result is not an error anyone can
 * catch: the process dies of SIGSEGV the first time a database handle is
 * collected, with no stack and no clue which line was to blame.
 *
 * So the check has to happen before anything opens one.
 */
const MIN_NODE_MAJOR = 24;

export function nodeVersionProblem(version: string = process.versions.node): string | null {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return [
    `sonn core needs Node ${MIN_NODE_MAJOR} or newer, and this is Node ${version}.`,
    'Native modules here are built for node-api 10 (Node 22+); on an older runtime they',
    'segfault during garbage collection instead of reporting anything. Install a supported',
    'Node and reinstall dependencies (npm ci) before running again.',
  ].join('\n');
}

/** Refuses to continue on a runtime whose native-module behaviour is unsafe. */
export function assertSupportedNodeVersion(): void {
  const problem = nodeVersionProblem();
  if (!problem) return;
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
