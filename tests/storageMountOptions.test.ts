import assert from 'node:assert/strict';
import { test } from './testHarness';
import { withMountDefaults } from '../src/adapters/content/storage/storageManager';

test('mount options: the defaults when the storage names none', () => {
  assert.deepEqual(withMountDefaults(['username=media'], ''), [
    'rw',
    'file_mode=0644',
    'dir_mode=0755',
    'username=media',
  ]);
});

test('mount options: what the storage names replaces our default (#438)', () => {
  assert.deepEqual(
    withMountDefaults(['username=media', 'password=x'], 'ro, file_mode=0600,iocharset=utf8'),
    ['dir_mode=0755', 'username=media', 'password=x', 'ro', 'file_mode=0600', 'iocharset=utf8'],
  );
});
