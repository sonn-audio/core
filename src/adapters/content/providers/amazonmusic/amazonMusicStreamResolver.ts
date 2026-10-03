import type { StreamProvider } from '@/adapters/content/StreamProvider';
import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { AmazonMusicStreamService } from '@/adapters/content/providers/amazonmusic/amazonMusicStreamService';

export class AmazonMusicStreamResolver implements StreamProvider {
  public readonly provider = 'amazonmusic';

  private readonly log = createLogger('Audio', 'AmazonMusicStream');

  constructor(private readonly streamService: AmazonMusicStreamService) {}

  public configure(): void {
    try {
      this.streamService.configureFromConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('amazon music stream config failed', { message });
    }
  }

  public isProvider(providerId: string): boolean {
    return this.streamService.isAmazonMusicProvider(providerId);
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<{ playbackSource: PlaybackSource | null; outputOnly?: boolean }> {
    return this.streamService.startStreamForAudiopath(zoneId, audiopath, options);
  }
}
