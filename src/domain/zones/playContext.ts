/**
 * What a zone is playing *from*: the album, playlist or artist its queue was started from.
 *
 * Not a property of the track — the same track is on an album and in a dozen playlists — and
 * not derivable from the queue afterwards. It is known at the moment a play request is
 * resolved and kept beside the zone from there.
 */
export type ZonePlayContext = {
  /** The container's audiopath, in the form the play request named it. */
  path: string;
  /** Its display name. A context without one is not kept. */
  name: string;
};
