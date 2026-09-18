import { readCapabilities } from '@sonn-audio/node-airplay';
import { createLogger } from '@/shared/logging/logger';
import type { AirplaySender } from '@/adapters/outputs/airplay/airplaySender';
import { Ap2Sender } from '@/adapters/outputs/airplay/ap2Sender';
import { RaopSender } from '@/adapters/outputs/airplay/raopSender';

export interface LaneSenderConfig {
  host: string;
  port?: number;
  password?: string;
  name?: string;
  /** Device encryption types (mDNS TXT `et`). */
  et?: string;
  /** mDNS TXT `features`/`ft`, as advertised. */
  features?: string;
  /** mDNS TXT `flags`/`sf`, as advertised. */
  flags?: string;
  /** mDNS TXT `model`/`am`, as advertised. */
  model?: string;
  bufferMs?: number;
  onUnavailable?: (reason: string) => void;
}

/**
 * Picks the AirPlay lane a device actually speaks, and holds it.
 *
 * There are two, and they share nothing but a name: AirPlay 2 pairs, encrypts
 * and follows a PTP or NTP clock, while AirPlay 1 (RAOP) announces over SDP and
 * counts frames. A device that only ever learned the older one cannot be talked
 * into the newer one — it answers the very first request with an error — so a
 * server that only speaks AirPlay 2 leaves that gear silent.
 *
 * What the device advertises decides it whenever we have the advertisement: a
 * receiver's mDNS features word says outright whether AirPlay 2 is there. Older
 * configurations were written before that was recorded, so for those the
 * AirPlay 2 handshake is tried first and a refusal falls through to RAOP.
 *
 * The fallback stops at Apple's own receivers. Those accept a whole RAOP session
 * on OS 27 and later and then render silence, so for them a refusal has to stay
 * one — a failure that says so is worth more than a session that looks healthy
 * and makes no sound.
 */
export class AirplayLaneSender implements AirplaySender {
  private readonly log = createLogger('Output', 'AirPlayLane');
  private readonly ap2: Ap2Sender | null;
  private readonly raop: RaopSender;
  /** The lane that answered; null until one has. */
  private active: AirplaySender | null = null;
  private starting = false;
  /** Whether a refused AirPlay 2 handshake may fall through to RAOP. */
  private readonly raopFallback: boolean;

  constructor(
    private readonly config: LaneSenderConfig,
    private readonly context: { zoneId: number; zoneName: string },
  ) {
    const { lane, appleReceiver } = readAdvertisedLane(config);
    // An Apple receiver on OS 27 and later accepts a whole RAOP session and then
    // renders silence, so for those a refusal has to stay a refusal. Everything
    // else may fall through: a third-party speaker that will not complete the
    // AirPlay 2 handshake usually still answers the older one.
    this.raopFallback = !appleReceiver;
    this.ap2 =
      lane === 'raop'
        ? null
        : new Ap2Sender(
            {
              host: config.host,
              ...(config.port !== undefined ? { port: config.port } : {}),
              ...(config.password !== undefined ? { password: config.password } : {}),
              ...(config.name !== undefined ? { name: config.name } : {}),
              ...(config.onUnavailable ? { onUnavailable: config.onUnavailable } : {}),
            },
            context,
          );
    this.raop = new RaopSender(
      {
        host: config.host,
        ...(config.port !== undefined ? { port: config.port } : {}),
        ...(config.et !== undefined ? { et: config.et } : {}),
        ...(config.bufferMs !== undefined ? { bufferMs: config.bufferMs } : {}),
      },
      context,
    );
    if (lane === 'raop') {
      this.log.info('device advertises AirPlay 1 only; using the RAOP lane', {
        ...context,
        host: config.host,
      });
    }
  }

  public isRunning(): boolean {
    return this.active?.isRunning() ?? false;
  }

  public getLatencyMs(): number {
    return (this.active ?? this.ap2 ?? this.raop).getLatencyMs();
  }

  public async start(source: NodeJS.ReadableStream, volume: number): Promise<boolean> {
    return this.startOnALane((sender) => sender.start(source, volume));
  }

  public async startForGroup(
    source: NodeJS.ReadableStream,
    volume: number,
    basePlayNtp: bigint,
    reAnchor: boolean,
  ): Promise<boolean> {
    return this.startOnALane((sender) =>
      sender.startForGroup(source, volume, basePlayNtp, reAnchor),
    );
  }

  public pause(): void {
    this.active?.pause();
  }

  public resume(source: NodeJS.ReadableStream): void {
    this.active?.resume(source);
  }

  public rebind(source: NodeJS.ReadableStream): void {
    this.active?.rebind(source);
  }

  public stop(): void {
    this.active?.stop();
    // Which lane runs next is decided again from scratch: a device that was
    // simply asleep must not be written off as the other kind for good.
    this.active = null;
  }

  public async setVolume(volume: number): Promise<void> {
    if (this.active) {
      await this.active.setVolume(volume);
      return;
    }
    // No lane yet — hand it to both, so whichever one opens starts at the right
    // level. Neither touches the network while it is not connected.
    await Promise.all([this.ap2?.setVolume(volume), this.raop.setVolume(volume)]);
  }

  public updateMetadata(payload: Parameters<AirplaySender['updateMetadata']>[0]): void {
    this.active?.updateMetadata(payload);
  }

  public setProgress(elapsedMs: number, durationMs: number): void {
    this.active?.setProgress(elapsedMs, durationMs);
  }

  /**
   * Run `attempt` on the chosen lane, or — while no lane has answered yet — on
   * AirPlay 2 first and RAOP after it refuses.
   */
  private async startOnALane(
    attempt: (sender: AirplaySender) => Promise<boolean>,
  ): Promise<boolean> {
    if (this.active) {
      return attempt(this.active);
    }
    if (this.starting) {
      return false;
    }
    this.starting = true;
    try {
      if (this.ap2 && (await attempt(this.ap2))) {
        this.active = this.ap2;
        return true;
      }
      if (this.ap2) {
        // Let go of the PCM source and the half-open session before anything
        // else primes from the same stream.
        this.ap2.stop();
        if (!this.raopFallback) {
          return false;
        }
        this.log.info('AirPlay 2 was refused; trying the AirPlay 1 (RAOP) lane', {
          ...this.context,
          host: this.config.host,
        });
      }
      if (await attempt(this.raop)) {
        this.active = this.raop;
        return true;
      }
      this.raop.stop();
      return false;
    } finally {
      this.starting = false;
    }
  }
}

/**
 * The lane the device's own advertisement calls for.
 *
 * `features` is what settles it: bit 38 (unified media control) and bit 48
 * (CoreUtils pairing) are what an AirPlay 2 receiver claims and an AirPlay 1 one
 * cannot. Without it — a config written before these were recorded — we start at
 * AirPlay 2 and let the device say no, which is the behaviour those zones have
 * now, minus the dead end.
 */
export function readAdvertisedLane(config: LaneSenderConfig): {
  lane: 'ap2' | 'raop';
  appleReceiver: boolean;
} {
  if (!config.features) {
    return { lane: 'ap2', appleReceiver: false };
  }
  const capabilities = readCapabilities({
    features: config.features,
    ...(config.flags !== undefined ? { flags: config.flags } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
  });
  return {
    lane: capabilities.supportsAirPlay2 ? 'ap2' : 'raop',
    appleReceiver: capabilities.isAppleReceiver,
  };
}
