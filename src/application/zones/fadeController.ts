import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Zones', 'FadeController');

export interface FadeOptions {
  fade?: boolean;
  fadeDurationMs?: number;
}

/**
 * Pulls the Miniserver's trailing parameter blob off a command.
 *
 * Loxone appends one as `<command>/?q&<base64>`, and the base64 decodes to something like
 * `fading&fadingTime=120` or `enforceUser=true`. Older firmware is less tidy about the separator —
 * the 3.x parser accepted a bare `q&` and a `/q&` too — so match the marker wherever it sits rather
 * than insisting on one spelling. A wake-up that silently starts at full volume because a slash was
 * missing is not a failure anyone can diagnose from the room (#392).
 */
function decodeParameterBlob(raw: string): string | null {
  const match = raw.match(/[/?]*q&([A-Za-z0-9+/=_-]+)\/*$/i);
  if (!match?.[1]) {
    return null;
  }
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8').trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

class FadeController {
  private readonly active = new Map<number, NodeJS.Timeout>();
  /** Zones muted by `prime` that have not had their ramp started yet. */
  private readonly primed = new Set<number>();
  private zoneManager: ZoneManagerFacade | null = null;

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('fade controller already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('fade controller missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  public parseFadeOptions(raw: string): FadeOptions {
    if (!raw) {
      return {};
    }
    const decoded = decodeParameterBlob(raw);
    if (!decoded) {
      return {};
    }
    if (!/fading/i.test(decoded)) {
      // Not a wake-up, but worth saying out loud: this is the only place the Miniserver can tell us
      // *why* a favourite is playing, and the parameters it uses are not documented anywhere. A
      // report of "the alarm starts too quietly" is unanswerable without knowing what arrived.
      log.debug('play command carried parameters, no fading', { parameters: decoded });
      return {};
    }
    const match = decoded.match(/fadingTime=(\d+)/i);
    const sec = match ? Number(match[1]) : undefined;
    return {
      fade: true,
      fadeDurationMs: sec && Number.isFinite(sec) ? Math.max(0, sec * 1000) : undefined,
    };
  }

  /**
   * The level a wake-up climbs to.
   *
   * Loxone calls `Vbuzzer` the *minimum* alarm volume, so it is a floor under the zone default and
   * not a replacement for it: a room that normally plays at 20 with `Vbuzzer` at 17 still wakes you
   * at 20 (#392). Before this it took whichever of the two happened to be the buzzer value, which
   * quietly lowered any zone whose default sat above it.
   */
  private fadeTarget(zoneId: number): number {
    const volumes = this.zones.getZoneVolumes(zoneId) as
      | { buzzer?: number; default?: number }
      | undefined;
    const fallback = Number(volumes?.default ?? 50);
    const buzzer = Number(volumes?.buzzer ?? fallback);
    const target = Math.max(
      Number.isFinite(fallback) ? fallback : 50,
      Number.isFinite(buzzer) ? buzzer : 0,
    );
    return Math.max(0, Math.min(100, target));
  }

  /**
   * Silence the zone *before* the music is asked for.
   *
   * The ramp used to be started after the play, which left the start of playback free to put the
   * zone default on the outputs first — so a gentle wake began with one second at the normal
   * listening level, which is the whole of what it was supposed to prevent. Muting first and
   * claiming the start volume closes that window (#392).
   */
  public prime(zoneId: number): void {
    this.cancel(zoneId);
    this.primed.add(zoneId);
    this.zones.keepVolumeOnNextStart(zoneId, true);
    this.zones.handleCommand(zoneId, 'volume_set', '0');
  }

  public async fadeIn(zoneId: number, durationMs: number): Promise<void> {
    const target = this.fadeTarget(zoneId);
    const intervalMs = 2000;
    const steps = Math.max(1, Math.round(durationMs / intervalMs));
    const floatDelta = target / steps;
    let step = 0;

    log.info('fading in', { zoneId, target, durationMs, steps });

    // `prime` normally did this, but a caller that only has the duration must still start muted.
    if (!this.primed.delete(zoneId)) {
      this.prime(zoneId);
      this.primed.delete(zoneId);
    }

    const interval = setInterval(() => {
      step += 1;
      const next = Math.min(target, Math.round(floatDelta * step));
      this.zones.handleCommand(zoneId, 'volume_set', String(next));
      if (step >= steps) {
        clearInterval(interval);
        this.active.delete(zoneId);
        // Hand the zone back. `onPlayerStarted` normally consumes the claim long before this, but a
        // favourite that never resolved would otherwise leave the room muted *and* holding a claim
        // on its own silence, so the next ordinary play would start at zero (the trap #358 was).
        this.zones.keepVolumeOnNextStart(zoneId, false);
      }
    }, intervalMs);

    this.active.set(zoneId, interval);
  }

  public cancel(zoneId: number): void {
    const wasPrimed = this.primed.delete(zoneId);
    const timer = this.active.get(zoneId);
    if (timer) {
      clearInterval(timer);
      this.active.delete(zoneId);
    }
    if (wasPrimed || timer) {
      this.zones.keepVolumeOnNextStart(zoneId, false);
    }
  }
}

export const fadeController = new FadeController();
