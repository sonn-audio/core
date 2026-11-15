import assert from 'node:assert/strict';
import { test } from './testHarness';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INSTALLED_RELEASE_FILE,
  isDevBuild,
  readBuildChannel,
  readBuildVersion,
  readGitBranch,
  writeInstalledRelease,
} from '../src/shared/serverVersion';

/** A throwaway working copy with just enough of a .git to be read. */
function withCheckout(head: string, fn: (dir: string) => void, asFile = false): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sonn-branch-'));
  try {
    const real = path.join(root, asFile ? 'actual-git' : '.git');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'HEAD'), head);
    if (asFile) {
      fs.writeFileSync(path.join(root, '.git'), `gitdir: ${real}\n`);
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function inCheckout(head: string, fn: () => void): void {
  withCheckout(head, (dir) => {
    const previous = process.cwd();
    try {
      process.chdir(dir);
      fn();
    } finally {
      process.chdir(previous);
    }
  });
}

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = { BUILD_CHANNEL: process.env.BUILD_CHANNEL, BUILD_TIMESTAMP: process.env.BUILD_TIMESTAMP };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('build channel is whatever the build declared', () => {
  for (const declared of ['dev', 'testing', 'beta', 'stable']) {
    withEnv({ BUILD_CHANNEL: declared, BUILD_TIMESTAMP: undefined }, () => {
      assert.equal(readBuildChannel(), declared);
    });
  }
});

test('an undeclared build is a dev build, never a release', () => {
  // The whole point: a release has to say so. Silence must not read as "stable",
  // or the one build people should not be running is the one with no warning.
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: undefined }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
  withEnv({ BUILD_CHANNEL: '', BUILD_TIMESTAMP: undefined }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
  // A value we do not recognise is not a promise of anything either.
  withEnv({ BUILD_CHANNEL: 'production', BUILD_TIMESTAMP: undefined }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
});

test('images built before BUILD_CHANNEL fall back to their build stamp', () => {
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: 'testing-20260815120000' }, () => {
    assert.equal(readBuildChannel(), 'testing');
  });
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: 'dev-20260815120000' }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
});

test('a declared channel outranks the build stamp', () => {
  withEnv({ BUILD_CHANNEL: 'stable', BUILD_TIMESTAMP: 'dev-20260815120000' }, () => {
    assert.equal(readBuildChannel(), 'stable');
  });
});

test('the branch of a working copy is read off .git/HEAD', () => {
  withCheckout('ref: refs/heads/beta\n', (dir) => {
    assert.equal(readGitBranch(dir), 'beta');
  });
  // Slashes survive: fix/foo is a branch name, not a path to walk.
  withCheckout('ref: refs/heads/fix/sendspin-format\n', (dir) => {
    assert.equal(readGitBranch(dir), 'fix/sendspin-format');
  });
  // A worktree points at its real git dir through a file rather than a directory.
  withCheckout('ref: refs/heads/dev\n', (dir) => {
    assert.equal(readGitBranch(dir), 'dev');
  }, true);
});

test('no branch to speak of is null, not a throw', () => {
  // Detached HEAD belongs to no branch.
  withCheckout('9f2c1ab5d3e4f6a7b8c9d0e1f2a3b4c5d6e7f8a9\n', (dir) => {
    assert.equal(readGitBranch(dir), null);
  });
  // And a directory that is not a checkout at all.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sonn-nogit-'));
  try {
    assert.equal(readGitBranch(bare), null);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('running from a working copy takes its channel from the branch', () => {
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: undefined }, () => {
    for (const [branch, channel] of [
      ['main', 'stable'],
      ['beta', 'beta'],
      ['test', 'testing'],
      ['dev', 'dev'],
    ] as const) {
      inCheckout(`ref: refs/heads/${branch}\n`, () => {
        assert.equal(readBuildChannel(), channel, `${branch} should read as ${channel}`);
      });
    }
  });
});

test('a working branch is a dev build, and so is a detached head', () => {
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: undefined }, () => {
    inCheckout('ref: refs/heads/feat/sonn-client-management-api\n', () => {
      assert.equal(readBuildChannel(), 'dev');
    });
    inCheckout('9f2c1ab5d3e4f6a7b8c9d0e1f2a3b4c5d6e7f8a9\n', () => {
      assert.equal(readBuildChannel(), 'dev');
    });
  });
});

test('an image has no repository, so the branch never speaks for it', () => {
  // The container carries no .git, so a build that declares nothing stays dev
  // wherever the process happens to be started from.
  withEnv({ BUILD_CHANNEL: 'stable', BUILD_TIMESTAMP: undefined }, () => {
    inCheckout('ref: refs/heads/dev\n', () => {
      assert.equal(readBuildChannel(), 'stable', 'a declared channel still wins');
    });
  });
});

test('a dev image updated in place to a beta release reports the beta', () => {
  // The update swaps dist/ and package.json but not the image's environment, which
  // still says dev and still carries the dev build stamp.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonn-installed-'));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const pkg = (version: string) => fs.writeFileSync('package.json', JSON.stringify({ version }));
    withEnv({ BUILD_CHANNEL: 'dev', BUILD_TIMESTAMP: 'dev-20261115.3' }, () => {
      pkg('4.0.0-beta.24');
      assert.equal(readBuildChannel(), 'dev', 'before any update the image speaks');
      assert.equal(readBuildVersion(), '4.0.0-beta.24+dev-20261115.3');

      writeInstalledRelease('4.0.0-beta.24');
      assert.equal(readBuildChannel(), 'beta');
      assert.equal(isDevBuild(), false, 'and it no longer gets the dev pass on the bundle gate');
      assert.equal(readBuildVersion(), '4.0.0-beta.24', 'without the dev stamp');

      writeInstalledRelease('4.0.0');
      pkg('4.0.0');
      assert.equal(readBuildChannel(), 'stable');

      pkg('4.0.1-beta.1');
      assert.equal(readBuildChannel(), 'dev', 'code put there another way is judged by its image again');
      assert.ok(fs.existsSync(INSTALLED_RELEASE_FILE));
    });
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
