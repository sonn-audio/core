/**
 * Service id stamped on every container this server hands a Sonos speaker. The speaker reports it
 * back in its playback metadata, which is how the state controller tells our own stream apart from
 * something started in the Sonos app.
 */
export const SONOS_OWN_CONTAINER_SERVICE_ID = 'sonn';

/**
 * True when `mediaUrl` is a stream this server hands a Sonos speaker: `/streams/<zoneId>/...` on
 * the host and port of `baseUrl`. Any scheme is accepted, because the SOAP path rewrites radio
 * streams to `x-rincon-mp3radio://`. A `/streams/` path on someone else's host is just an
 * external station that happens to use the same path.
 */
export function isOwnStreamUrl(mediaUrl: string, baseUrl: string): boolean {
  if (!mediaUrl || !baseUrl) {
    return false;
  }
  try {
    const parsed = new URL(mediaUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, 'http://'));
    const base = new URL(baseUrl);
    return parsed.host.toLowerCase() === base.host.toLowerCase() && /^\/streams\/\d+\//.test(parsed.pathname);
  } catch {
    return false;
  }
}
