import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamProvider } from '@/adapters/content/StreamProvider';
import type { StreamProxyRoute } from '@/shared/streamProxyRoute';
import { AppleMusicStreamService } from '@/adapters/content/providers/applemusic/appleMusicStreamService';
import { AppleMusicStreamResolver } from '@/adapters/content/providers/applemusic/appleMusicStreamResolver';
import { setAppleMusicDeveloperTokenSource } from '@/adapters/content/providers/applemusic/appleMusicAuth';
import { DeezerStreamService } from '@/adapters/content/providers/deezer/deezerStreamService';
import { DeezerStreamResolver } from '@/adapters/content/providers/deezer/deezerStreamResolver';
import { TidalStreamService } from '@/adapters/content/providers/tidal/tidalStreamService';
import { TidalStreamResolver } from '@/adapters/content/providers/tidal/tidalStreamResolver';
import { YtMusicStreamService } from '@/adapters/content/providers/ytmusic/ytmusicStreamService';
import { YtMusicStreamResolver } from '@/adapters/content/providers/ytmusic/ytmusicStreamResolver';
import { YoutubeStreamService } from '@/adapters/content/providers/youtube/youtubeStreamService';
import { YoutubeStreamResolver } from '@/adapters/content/providers/youtube/youtubeStreamResolver';
import { SoundCloudStreamService } from '@/adapters/content/providers/soundcloud/soundcloudStreamService';
import { SoundCloudStreamResolver } from '@/adapters/content/providers/soundcloud/soundcloudStreamResolver';
import { AmazonMusicStreamService } from '@/adapters/content/providers/amazonmusic/amazonMusicStreamService';
import { AmazonMusicStreamResolver } from '@/adapters/content/providers/amazonmusic/amazonMusicStreamResolver';

/** How a stream service says a zone's playback failed. */
type OutputErrorHandler = (zoneId: number, reason?: string) => void;

export type StreamProviders = {
  /**
   * Ordered: the content adapter asks them in turn, so the first to claim an
   * ambiguous audiopath is the one that gets it.
   */
  resolvers: StreamProvider[];
  /**
   * The services that hand the player a URL on our own host instead of the
   * service's — DRM manifests and segment fetches that need our credentials.
   * Four of the seven do.
   */
  proxyRoutes: StreamProxyRoute[];
};

/**
 * Build the seven bridged streaming services and the resolvers that front them.
 *
 * They are constructed identically — an error callback and the config port —
 * and the composition root has nothing to say about any of them individually,
 * so it asks for the set instead of naming twelve constants.
 */
export function createStreamProviders(
  configPort: ConfigPort,
  onOutputError: OutputErrorHandler,
): StreamProviders {
  // Sourced live from config so the auth flow and the API bearer always read the
  // token that is configured now, not the one that was there at startup.
  setAppleMusicDeveloperTokenSource(
    () => configPort.getConfig().content?.appleMusic?.developerToken,
  );

  const appleMusic = new AppleMusicStreamService(onOutputError, configPort);
  const deezer = new DeezerStreamService(onOutputError, configPort);
  const tidal = new TidalStreamService(onOutputError, configPort);
  const ytmusic = new YtMusicStreamService(onOutputError, configPort);
  const youtube = new YoutubeStreamService(onOutputError, configPort);
  const soundcloud = new SoundCloudStreamService(onOutputError, configPort);
  const amazonMusic = new AmazonMusicStreamService(onOutputError, configPort);

  return {
    resolvers: [
      new AppleMusicStreamResolver(appleMusic),
      new DeezerStreamResolver(deezer),
      new TidalStreamResolver(tidal),
      new YtMusicStreamResolver(ytmusic),
      new YoutubeStreamResolver(youtube),
      new SoundCloudStreamResolver(soundcloud),
      new AmazonMusicStreamResolver(amazonMusic),
    ],
    proxyRoutes: [
      tidal.getProxyRoute(),
      deezer.getProxyRoute(),
      appleMusic.getProxyRoute(),
      amazonMusic.getProxyRoute(),
    ],
  };
}
