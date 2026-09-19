import assert from 'node:assert/strict';
import { test } from './testHarness';
import { nodeVersionProblem } from '../src/shared/utils/nodeVersion';

// The guard exists because an unsupported runtime does not fail politely: native
// modules built for node-api 10 segfault during garbage collection on Node 20,
// which is what issue #384 reported as "npm test segfaults on arm64".

test('node guard: a runtime below the floor is named, with the reason', () => {
  const problem = nodeVersionProblem('20.19.2');
  assert.ok(problem, 'Node 20 must be refused');
  assert.match(problem, /Node 20\.19\.2/);
  assert.match(problem, /node-api 10/);
});

test('node guard: a supported runtime passes', () => {
  assert.equal(nodeVersionProblem('24.11.1'), null);
  assert.equal(nodeVersionProblem('26.0.0'), null);
});

test('node guard: an unparsable version is not treated as too old', () => {
  // Better to run and let the real failure speak than to refuse on a string we
  // could not read.
  assert.equal(nodeVersionProblem('not-a-version'), null);
});
