const STEMS = ['cover', 'folder', 'front', 'album', 'albumart'];
const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * The album picture among a folder's files, by the names rippers and taggers give it.
 *
 * `cover.*` is one convention of several: `folder.jpg` is what Windows and most rippers write,
 * `front.jpg` what scanned artwork is usually called. Case is ignored — `Folder.jpg` and
 * `Cover.JPG` are everywhere on shares that came from a case-insensitive disk — and the name is
 * returned as it is spelled on disk, since that is the name it has to be fetched by.
 *
 * A `cover` wins over the others so that a picture this server stored earlier stays the one in use.
 */
export function pickFolderCover(fileNames: readonly string[]): string | undefined {
  const byLowerName = new Map<string, string>();
  for (const name of fileNames) {
    const lower = name.toLowerCase();
    if (!byLowerName.has(lower)) {
      byLowerName.set(lower, name);
    }
  }
  for (const stem of STEMS) {
    for (const extension of EXTENSIONS) {
      const found = byLowerName.get(`${stem}.${extension}`);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
