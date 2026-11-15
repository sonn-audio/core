/**
 * The running server's version, as reported on every outward surface.
 *
 * Shared so the admin API's `/info` and the public API's `/api/health` can never
 * disagree about what is running.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readPackageVersion(): string {
  try {
    const json = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(json) as { version?: string };
    return parsed.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * Which release channel this build came off.
 *
 * Consumers use it to say out loud that a build is not meant for a real system —
 * `dev` rebuilds on every push to the branch, so it is the one people end up
 * running by accident.
 *
 * The default is deliberately `dev`, not `stable`: a build that does not claim to
 * be a release is not one. Getting this wrong in that direction shows a warning on
 * a release; the other direction hides it on exactly the build that needs it.
 */
export type BuildChannel = 'dev' | 'testing' | 'beta' | 'stable';

const BUILD_CHANNELS: readonly BuildChannel[] = ['dev', 'testing', 'beta', 'stable'];

/**
 * Written next to `package.json` by the in-place core update.
 *
 * The image states its channel in `BUILD_CHANNEL` and `BUILD_TIMESTAMP`, and an in-place
 * update cannot change those: it swaps `dist/` and the manifests, not the environment. A dev
 * image updated to a beta release would go on calling itself dev, with the dev build stamp
 * on the beta version and the dev pass on the bundle gate. This file says what was really
 * installed, and holds only while `package.json` still carries the version it was written
 * for, so code put there any other way is judged by its image again.
 */
export const INSTALLED_RELEASE_FILE = 'installed-release.json';

type InstalledRelease = { version: string; channel: BuildChannel };

export function writeInstalledRelease(version: string, cwd: string = process.cwd()): void {
  const channel: BuildChannel = version.includes('-') ? 'beta' : 'stable';
  const record: InstalledRelease = { version, channel };
  writeFileSync(resolve(cwd, INSTALLED_RELEASE_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

function readInstalledRelease(): InstalledRelease | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(process.cwd(), INSTALLED_RELEASE_FILE), 'utf8')) as
      Partial<InstalledRelease>;
    if (
      typeof raw.version !== 'string' ||
      raw.version !== readPackageVersion() ||
      !(BUILD_CHANNELS as readonly unknown[]).includes(raw.channel)
    ) {
      return null;
    }
    return { version: raw.version, channel: raw.channel as BuildChannel };
  } catch {
    return null;
  }
}

/** Branches that stand for a channel. Anything else is somebody's working branch. */
const BRANCH_CHANNELS: Readonly<Record<string, BuildChannel>> = {
  main: 'stable',
  beta: 'beta',
  test: 'testing',
  testing: 'testing',
  dev: 'dev',
};

/**
 * The checked-out branch, when the server runs from a working copy.
 *
 * Read straight off `.git/HEAD` rather than by shelling out to git: this is on
 * the path of an API request, and a detached HEAD or a missing repository has to
 * be an ordinary `null`, not a thrown error or a spawned process.
 */
export function readGitBranch(cwd: string = process.cwd()): string | null {
  try {
    let gitDir = resolve(cwd, '.git');
    const stat = statSync(gitDir);
    if (stat.isFile()) {
      // A worktree or submodule: `.git` is a file pointing at the real directory.
      const pointer = readFileSync(gitDir, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!match?.[1]) {
        return null;
      }
      gitDir = resolve(cwd, match[1]);
    }
    const head = readFileSync(resolve(gitDir, 'HEAD'), 'utf8').trim();
    // Detached HEAD holds a bare commit id and belongs to no branch.
    return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function readBuildChannel(): BuildChannel {
  const installed = readInstalledRelease();
  if (installed) {
    return installed.channel;
  }
  const declared = process.env.BUILD_CHANNEL?.trim().toLowerCase();
  if (declared && (BUILD_CHANNELS as readonly string[]).includes(declared)) {
    return declared as BuildChannel;
  }
  // Older images predate BUILD_CHANNEL but stamp the channel into the build id.
  const stamp = process.env.BUILD_TIMESTAMP?.trim().toLowerCase() ?? '';
  if (stamp.startsWith('testing-')) {
    return 'testing';
  }
  // Running from a working copy: the branch is what this checkout is tracking, and
  // it is the only honest answer available. An image carries no repository, so this
  // never applies there — it stays on the default below.
  const branch = readGitBranch()?.trim().toLowerCase();
  if (branch && BRANCH_CHANNELS[branch]) {
    return BRANCH_CHANNELS[branch];
  }
  return 'dev';
}

/**
 * Whether this is explicitly a development build.
 *
 * Separate from `readBuildChannel` because of that function's default: it answers `dev`
 * for anything that does not claim otherwise, which is the right way round for a warning
 * ("this might not be a release") and the wrong way round for a permission. A deployment
 * that simply carries no channel — a server-dist tarball unpacked outside a repository —
 * must not inherit whatever dev is allowed to do.
 *
 * What it is allowed to do is skip the bundle compatibility gate. On `dev` the version
 * number is the only thing that lags: the branch carries the endpoints of the next release
 * while still calling itself the last one, so a bundle built against those endpoints is
 * refused by a check that is, on this branch alone, measuring the wrong thing. Nobody runs
 * dev except to try a fix, and what they need there is the newest of everything.
 */
export function isDevBuild(): boolean {
  const installed = readInstalledRelease();
  if (installed) {
    return installed.channel === 'dev';
  }
  const declared = process.env.BUILD_CHANNEL?.trim().toLowerCase();
  if (declared && (BUILD_CHANNELS as readonly string[]).includes(declared)) {
    return declared === 'dev';
  }
  const stamp = process.env.BUILD_TIMESTAMP?.trim().toLowerCase() ?? '';
  if (stamp.startsWith('dev-')) {
    return true;
  }
  if (stamp.startsWith('testing-')) {
    return false;
  }
  return readGitBranch()?.trim().toLowerCase() === 'dev';
}

/** Appends the CI build stamp when present, so nightly builds are distinguishable. */
export function readBuildVersion(pkgVersion: string = readPackageVersion()): string {
  // A release installed by the update is that release; the image's build stamp is not its.
  if (readInstalledRelease()) {
    return pkgVersion;
  }
  const tsRaw = process.env.BUILD_TIMESTAMP?.trim();
  if (!tsRaw) {
    return pkgVersion;
  }
  const normalizedTs = tsRaw.replace(/[^0-9A-Za-z._-]/g, '');
  if (!normalizedTs) {
    return pkgVersion;
  }
  return `${pkgVersion}+${normalizedTs}`;
}
