import assert from 'node:assert/strict';
import { test } from './testHarness';
import { GroupVolumeBalance } from '../src/application/groups/groupVolumeBalance';

// Rooms: 1 leads at 50, the bedroom (2) sits at 10, the kitchen (3) at 70.
const start = (): Map<number, number> => new Map([[1, 50], [2, 10], [3, 70]]);

/** Moves the group and returns where the rooms end up, as the group manager does. */
function move(balance: GroupVolumeBalance, volumes: Map<number, number>, target: number): Map<number, number> {
  const next = balance.plan(1, target, volumes);
  balance.applied(1, next);
  return next;
}

test('group volume: rooms move together while nothing hits an end', () => {
  const balance = new GroupVolumeBalance();
  assert.deepEqual([...move(balance, start(), 60)], [[1, 60], [2, 20], [3, 80]]);
});

test('group volume: down to nothing and back up restores how the rooms stood', () => {
  const balance = new GroupVolumeBalance();
  let volumes = move(balance, start(), 0);
  assert.deepEqual([...volumes], [[1, 0], [2, 0], [3, 20]]);
  volumes = move(balance, volumes, 50);
  assert.deepEqual([...volumes], [[1, 50], [2, 10], [3, 70]]);
});

test('group volume: up against the top and back keeps the loud room loud, not louder', () => {
  const balance = new GroupVolumeBalance();
  let volumes = move(balance, start(), 100);
  assert.deepEqual([...volumes], [[1, 100], [2, 60], [3, 100]]);
  volumes = move(balance, volumes, 50);
  assert.deepEqual([...volumes], [[1, 50], [2, 10], [3, 70]]);
});

test('group volume: a room changed on its own becomes the new starting point', () => {
  const balance = new GroupVolumeBalance();
  const volumes = move(balance, start(), 0);
  // Somebody turns the bedroom up by hand while the group is at zero.
  volumes.set(2, 30);
  assert.deepEqual([...move(balance, volumes, 10)], [[1, 10], [2, 40], [3, 30]]);
});

test('group volume: a member joining or leaving starts over from what the rooms are', () => {
  const balance = new GroupVolumeBalance();
  const volumes = move(balance, start(), 0);
  volumes.delete(3);
  assert.deepEqual([...move(balance, volumes, 20)], [[1, 20], [2, 20]]);
});
