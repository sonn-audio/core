/**
 * The origin clients fetch this server's own images from — station icons, library covers,
 * collages and the zone cover route.
 *
 * The server always serves plain HTTP on its gateway port; a reverse proxy usually terminates TLS
 * in front of it. A Loxone Web UI served over HTTPS refuses an HTTP image as mixed content, so the
 * scheme and port are configuration (`system.audioserver.artworkProtocol` / `artworkPort`) and the
 * host is the one every client-facing url already names (`system.audioserver.ip`). Both default to
 * the plain gateway, so an install that never sets them emits exactly what it always did.
 */
export type ArtworkOriginSettings = {
  protocol?: 'http' | 'https' | null;
  port?: number | null;
};

export function artworkOrigin(host: string, settings: ArtworkOriginSettings = {}): string {
  const protocol = settings.protocol === 'https' ? 'https' : 'http';
  const fallbackPort = protocol === 'https' ? 443 : 7090;
  const port =
    typeof settings.port === 'number' &&
    Number.isInteger(settings.port) &&
    settings.port > 0 &&
    settings.port <= 65535
      ? settings.port
      : fallbackPort;
  const cleanHost = host.trim() || '127.0.0.1';
  // A default port is left out of the url, as clients and caches expect.
  const defaultPort = protocol === 'https' ? 443 : 80;
  return port === defaultPort ? `${protocol}://${cleanHost}` : `${protocol}://${cleanHost}:${port}`;
}

/** An absolute url for a path this server serves, on the configured artwork origin. */
export function localImageUrl(
  pathAndQuery: string,
  host: string,
  settings: ArtworkOriginSettings = {},
): string {
  const suffix = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  return `${artworkOrigin(host, settings)}${suffix}`;
}
