import type { ZonePlayContext } from '@/domain/zones/playContext';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ContentFolderItem } from '@/ports/ContentTypes';

/** What of a resolved play request decides whether it has a context, and which. */
export type PlayContextRequest = {
  isRadio: boolean;
  isLineIn: boolean;
  parentContext: { parent: string } | null;
  resolvedTarget: string;
  provider: string | null;
  nextInput: ZoneContext['inputMode'];
};

/** The part of a zone this needs: where the context is kept, and what says it still applies. */
type ContextHolder = Pick<ZoneContext, 'metadata' | 'inputMode'>;

type StoredPlayContext = ZonePlayContext & { inputMode: ZoneContext['inputMode'] };

/**
 * The container a play request starts a queue from, or null when it has none.
 *
 * Either the request named the container the track was picked from, or the request *was* the
 * container and expanded into more than itself. A single track played on its own has no
 * context, and neither has radio or a line-in.
 */
export function playContextPath(
  req: PlayContextRequest,
  queueItems: ReadonlyArray<{ audiopath?: string }>,
): string | null {
  if (req.isRadio || req.isLineIn) {
    return null;
  }
  const expanded = queueItems.length > 1 && queueItems[0]?.audiopath !== req.resolvedTarget;
  return req.parentContext?.parent || (expanded ? req.resolvedTarget : '') || null;
}

/** Whatever the zone was playing from, it is not playing from it any more. */
export function forgetPlayContext(zone: ContextHolder): void {
  delete zone.metadata.playContext;
  delete zone.metadata.playContextToken;
}

/**
 * Remember which album, playlist or artist this queue was started from.
 *
 * A track says which album it is on, not what the listener opened to get to it — a playlist,
 * a "liked songs" list, an artist's top tracks. That is known when the request is resolved
 * and nowhere later.
 *
 * The name is looked up rather than guessed, and without one nothing is remembered: a client
 * shows it ("playing from …"), so a context it cannot name is worse than none. The lookup is
 * started from inside a promise so that nothing about it — a lookup that throws, a provider
 * that is down — can reach the play request it rides along with.
 */
export function rememberPlayContext(
  zone: ContextHolder,
  req: PlayContextRequest,
  queueItems: ReadonlyArray<{ audiopath?: string }>,
  deps: {
    resolveFolder: (service: string, user: string, folderId: string) => Promise<ContentFolderItem | null>;
    /** Called once the context is in place, so the zone can be announced with it. */
    onRemembered: () => void;
  },
): void {
  forgetPlayContext(zone);
  const path = playContextPath(req, queueItems);
  if (!path) {
    return;
  }
  const token = `${path}@${Date.now()}@${Math.random()}`;
  zone.metadata.playContextToken = token;
  void Promise.resolve()
    .then(() => deps.resolveFolder(req.provider ?? '', 'nouser', path))
    .then((folder) => {
      const name = folder?.name?.trim();
      // A newer play request has taken over while this one was being named.
      if (!name || zone.metadata.playContextToken !== token) {
        return;
      }
      const context: StoredPlayContext = { path, name, inputMode: req.nextInput };
      zone.metadata.playContext = context;
      deps.onRemembered();
    })
    .catch(() => {
      // No name, no context — see above.
    });
}

/**
 * The container a zone's queue was started from, while that queue is still what it plays.
 *
 * Remembered with the input it belongs to: an AirPlay stream or a line-in that takes the zone
 * over never passes a play request, so the input is what says the context no longer applies.
 */
export function readPlayContext(zone: ContextHolder | undefined): ZonePlayContext | null {
  const kept = zone?.metadata.playContext as StoredPlayContext | undefined;
  if (!zone || !kept || kept.inputMode !== zone.inputMode) {
    return null;
  }
  return { path: kept.path, name: kept.name };
}
