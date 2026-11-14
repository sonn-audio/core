/**
 * Whether the Widevine CDM files on disk form a usable set.
 *
 * A value rather than an exception, which is the point of this port. The provider signals a bad
 * set by throwing its own `WidevineArtifactsError`, and the admin route used to catch it with
 * `instanceof` — so the HTTP layer had to import a provider's error class to answer a request.
 * Anything else still throws: an unreadable directory is not a verdict about the files.
 */
export type WidevineVerification =
  /** `source` says whose CDM it is: one the user uploaded, or the one the image was built with. */
  | { ok: true; source: 'uploaded' | 'bundled' }
  | { ok: false; code: 'missing' | 'invalid'; details: string[] };

/**
 * Administering the Apple Music integration: its developer token and its Widevine CDM files.
 *
 * Apple Music playback needs a Widevine CDM — the one a release image is built with, or one the
 * user uploads in its place — so "is there a usable set, and whose is it" is a question the setup
 * screen asks and nothing else does. Both operations here are management; neither is used to play anything.
 */
export interface AppleMusicAdminPort {
  /** The developer token from config, or null when the install relies on a scraped one. */
  configuredDeveloperToken(): string | null;
  /** A token lifted from Apple's web player, for installs without one in config; null when none is found. */
  scrapedDeveloperToken(): Promise<string | null>;
  /** Re-reads the CDM files, ignoring any cached set, and reports what they are worth. */
  verifyWidevineArtifacts(): Promise<WidevineVerification>;
}
