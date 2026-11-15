import type { NotifierPort, PlaybackFailure } from '@/ports/NotifierPort';
import type { AudioSyncGroupPayload } from '@/application/groups/types/AudioSyncGroupPayload';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';

export class LoxoneNotifierAdapter implements NotifierPort {
  constructor(private readonly notifier: LoxoneWsNotifier) {}

  notifyZoneStateChanged(state: Parameters<NotifierPort['notifyZoneStateChanged']>[0]): void {
    this.notifier.notifyZoneStateChanged(state);
  }

  notifyQueueUpdated(zoneId: number, queueSize: number): void {
    this.notifier.notifyQueueUpdated(zoneId, queueSize);
  }

  notifyRoomFavoritesChanged(zoneId: number, count: number): void {
    this.notifier.notifyRoomFavoritesChanged(zoneId, count);
  }

  notifyRecentlyPlayedChanged(zoneId: number, timestamp: number): void {
    this.notifier.notifyRecentlyPlayedChanged(zoneId, timestamp);
  }

  notifyRescan(status: 0 | 1 | 2, folders?: number, files?: number): void {
    this.notifier.notifyRescan(status, folders, files);
  }

  notifyReloadMusicApp(action: 'useradd' | 'userdel', provider: string, userId: string): void {
    this.notifier.notifyReloadMusicApp(action, provider, userId);
  }

  notifyAudioSyncEvent(payload: AudioSyncGroupPayload[]): void {
    this.notifier.notifyAudioSyncEvent(payload);
  }

  notifyPlaybackFailed(zoneId: number, failure: PlaybackFailure): void {
    this.notifier.notifyPlaybackFailed(zoneId, failure);
  }
}
