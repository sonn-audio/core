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
    // A speaker can report the URI with the original scheme nested inside its own,
    // `x-rincon-mp3radio://http://<host>:7090/streams/…` (seen from an S1 over SOAP), so every
    // leading scheme is stripped, not just the first (#444).
    const parsed = new URL(`http://${mediaUrl.replace(/^(?:[a-z][a-z0-9+.-]*:\/\/)+/i, '')}`);
    const base = new URL(baseUrl);
    return parsed.host.toLowerCase() === base.host.toLowerCase() && /^\/streams\/\d+\//.test(parsed.pathname);
  } catch {
    return false;
  }
}
