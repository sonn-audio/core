export interface FadeOptions {
  fade?: boolean;
  fadeDurationMs?: number;
}

export interface FadeControllerPort {
  parseFadeOptions(raw: string): FadeOptions;
  /** Mute the zone and claim its start volume, before the play that will be faded in. */
  prime(zoneId: number): void;
  fadeIn(zoneId: number, durationMs: number): Promise<void>;
}
