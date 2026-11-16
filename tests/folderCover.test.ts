import assert from 'node:assert/strict';
import { test } from './testHarness';
import { pickFolderCover } from '../src/adapters/content/providers/folderCover';

test('folder cover: the names rippers write are recognised, as spelled on disk', () => {
  assert.equal(pickFolderCover(['01 Song.flac', 'Folder.jpg']), 'Folder.jpg');
  assert.equal(pickFolderCover(['front.PNG', 'notes.txt']), 'front.PNG');
  assert.equal(pickFolderCover(['AlbumArt.jpeg']), 'AlbumArt.jpeg');
});

test('folder cover: a cover file wins over the other names', () => {
  assert.equal(pickFolderCover(['folder.jpg', 'cover.png', 'front.jpg']), 'cover.png');
});

test('folder cover: other pictures in the folder are not the cover', () => {
  assert.equal(pickFolderCover(['back.jpg', 'booklet-01.png', 'artist.jpg']), undefined);
  assert.equal(pickFolderCover([]), undefined);
});
