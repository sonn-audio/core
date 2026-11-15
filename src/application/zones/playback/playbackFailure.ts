import type { ZoneContext } from '@/application/zones/internal/zoneTypes';

/** How long a provider's last word on a zone still explains why that zone is not playing. */
export const PLAYBACK_ERROR_EXPLAINS_FOR_MS = 30_000;

/** What the provider last reported for this zone, when that was recent enough to be the cause. */
export function recentPlaybackErrorReason(
  ctx: Pick<ZoneContext, 'lastPlaybackErrorReason' | 'lastPlaybackErrorAt'>,
  now: number = Date.now(),
): string | undefined {
  const reason = ctx.lastPlaybackErrorReason?.trim();
  if (!reason || !ctx.lastPlaybackErrorAt || now - ctx.lastPlaybackErrorAt > PLAYBACK_ERROR_EXPLAINS_FOR_MS) {
    return undefined;
  }
  return reason;
}

/**
 * Whether an error is a service refusing the account, read off its shape.
 *
 * The content adapters throw `ProviderUnavailableError` for that; this layer may not import an
 * adapter's class, and does not need to — the name and the reason are the whole of it.
 */
export function serviceRefusalOf(error: unknown): 'auth' | 'denied' | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const { name, reason } = error as { name?: unknown; reason?: unknown };
  if (name !== 'ProviderUnavailableError') {
    return null;
  }
  return reason === 'auth' || reason === 'denied' ? reason : null;
}
