import type { PlaybackMetadata } from '@/ports/types/playback';
import type { PreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';

export type PlaybackKind = 'queue' | 'live-input' | 'provider-stream';
export type ProviderKind =
  | 'applemusic'
  | 'deezer'
  | 'tidal'
  | 'amazonmusic'
  | 'ytmusic'
  | 'youtube'
  | 'soundcloud'
  | null;

export type PlaybackPlan = {
  zoneId: number;
  zoneName: string;
  audiopath: string;
  kind: PlaybackKind;
  isRadio: boolean;
  provider: ProviderKind;
  playExternalLabel: string | null;
  needsStreamResolution: boolean;
  metadata: PlaybackMetadata;
  preferredSettings: PreferredPlaybackSettings;
};
