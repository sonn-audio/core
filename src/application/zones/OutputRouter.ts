import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackSession } from '@/ports/types/playback';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import {
  dispatchOutputs,
  dispatchVolume,
  selectPlayOutputs,
} from '@/application/zones/services/outputOrchestrator';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { clearPlayers } from '@/application/playback/playerRegistry';
import { ZoneRepository } from '@/application/zones/ZoneRepository';
import { followsLeaderStream } from '@/application/zones/helpers/groupFollower';

export class OutputRouter {
  constructor(
    private readonly log: ComponentLogger,
    private readonly outputErrorNotifier: (zoneId: number, reason?: string) => void,
    private readonly audioManager: AudioManager,
  ) {}

  public dispatchOutputs(
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ): void {
    const targets = this.outputsDrivenByZone(ctx, outputs, payload);
    if (targets.length !== outputs.length) {
      this.log.debug('own playback of a group member kept off the speaker that follows its leader', {
        zoneId: ctx.id,
        action,
        source: payload?.source,
      });
    }
    dispatchOutputs(ctx, targets, action, payload, this.log, this.outputErrorNotifier);
  }

  /**
   * The outputs a zone's own playback may drive.
   *
   * Not the speaker of a member that plays its leader's stream (#409). Whatever the member
   * still starts on its own — Soloist bringing back a Spotify session of the room's, a
   * Connect or AirPlay takeover, a stray play of its own queue — has no business there:
   * the player belongs to the group, and to the member's hold while it sits the group out.
   * A play of the member's own reached that player while it was held, and since a held
   * member is left out of the group, the output played the session on its own and the
   * room was audible again with music nobody in the group was playing. A pause or stop of
   * the member's own session paused the whole group or dropped the room out of it.
   *
   * The member's own commands do not come this way: its pause and play as a member go to
   * the output's member controls, and the stop of a held member to the output directly.
   * An alert is the exception that still plays on the member's speaker, as it did.
   *
   * Such a speaker is the one whose output offers a member pause (see `followsLeaderStream`).
   */
  public outputsDrivenByZone(
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    payload?: PlaybackSession | null,
  ): ZoneOutput[] {
    if (ctx.alert || payload?.metadata?.isAlert) {
      return outputs;
    }
    return outputs.filter((output) => !followsLeaderStream([output]));
  }

  public dispatchVolume(ctx: ZoneContext, outputs: ZoneOutput[], volume: number): void {
    dispatchVolume(ctx, outputs, volume, this.log);
  }

  public selectPlayOutputs(outputs: ZoneOutput[], _session: PlaybackSession | null): ZoneOutput[] {
    return selectPlayOutputs(outputs);
  }

  public notifyOutputMetadata(
    zoneId: number,
    ctx: ZoneContext,
    patch: Partial<ZoneState>,
  ): void {
    // Only trigger when metadata-relevant fields change.
    const touchesMeta =
      'title' in patch ||
      'artist' in patch ||
      'album' in patch ||
      'coverurl' in patch ||
      'duration' in patch ||
      'station' in patch ||
      'sourceName' in patch;
    if (!touchesMeta) {
      return;
    }
    const now = Date.now();
    const patchKeys = Object.keys(patch);
    const isTimeOnly = patchKeys.length === 1 && patchKeys[0] === 'time';
    // Limit pure time ticks to once per second to avoid noisy metadata spam.
    if (isTimeOnly && now - ctx.lastMetadataDispatchAt < 1000) {
      return;
    }
    ctx.lastMetadataDispatchAt = now;
    const session = this.audioManager.getSession(zoneId);
    const targets =
      ctx.activeOutput !== null
        ? ctx.outputs.filter((t) => t.type === ctx.activeOutput)
        : ctx.outputs;

    this.log.spam('dispatch output metadata', {
      zoneId,
      activeOutput: ctx.activeOutput,
      targetCount: targets.length,
    });

    for (const output of targets) {
      if (typeof output.updateMetadata === 'function') {
        try {
          const result = output.updateMetadata(session);
          if (result instanceof Promise) {
            void result.catch((err) =>
              this.log.debug('output metadata update failed', {
                zoneId,
                type: output.type,
                message: (err as Error)?.message ?? String(err),
              }),
            );
          }
        } catch (err) {
          this.log.debug('output metadata update failed', {
            zoneId,
            type: output.type,
            message: (err as Error)?.message ?? String(err),
          });
        }
      }
    }
  }

  public async stopOutputs(
    outputs: ZoneOutput[],
    session: PlaybackSession | null | undefined,
  ): Promise<void> {
    await Promise.all(
      outputs.map(async (output) => {
        try {
          await output.stop(session ?? null);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.warn('output stop failed', { zoneId: session?.zoneId, message });
        }
      }),
    );
  }

  /**
   * Dispose a zone's outputs when their context dies. Stop is not enough: an output holds
   * standing machinery beyond the playing session — a DLNA output keeps a GENA subscription
   * with its renewal loop and callback server — and left undisposed it survives a zone rebuild
   * as a zombie that keeps injecting the renderer's volume events into the zone (issue #358).
   */
  public disposeOutputs(zoneId: number, outputs: ZoneOutput[]): void {
    for (const output of outputs ?? []) {
      try {
        const result = output.dispose();
        if (result instanceof Promise) {
          void result.catch((error) => {
            this.log.warn('output dispose failed', {
              zoneId,
              message: (error as Error).message,
            });
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('output dispose failed', { zoneId, message });
      }
    }
  }

  public disposeAllOutputs(zoneRepo: ZoneRepository): void {
    for (const ctx of zoneRepo.list()) {
      this.disposeOutputs(ctx.id, ctx.outputs ?? []);
    }
    clearPlayers();
  }
}
