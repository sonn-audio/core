import type { ContentManager } from '@/adapters/content/contentManager';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import { buildResponse } from '@/adapters/loxone/commands/responses';
import {
  decodeSegment,
  extractPayload,
  parseNumberPart,
  splitCommand,
} from '@/adapters/loxone/commands/utils/commandUtils';
import { BASE_PLAYLIST, encodeLoxoneId } from '@/adapters/loxone/commands/utils/loxoneIdCodec';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Loxone', 'QueueEdit');

/**
 * Handlers for the full Loxone queue-edit command set (refcode parity):
 *   queueadd / queueinsert / queueandplay   (legacy paths, take an audiopath)
 *   queue/play/<uid> / queue/move/<uid>/before/<uid|end> / queue/remove/<uid>  (QUEUE_V2)
 *   queue/clear / queueundo
 *   playlist/save/<name>                     (save the queue as a local playlist)
 *
 * Result keys mirror the client Zod schemas (legacy/comps.js). After each
 * mutation the application layer emits `audio_queue_event`, which is what the
 * client uses to refresh its queue view — the ack body below is secondary.
 */
export function createQueueEditHandlers(
  zoneManager: ZoneManagerFacade,
  contentManager: ContentManager,
  notifier: LoxoneWsNotifier,
) {
  return {
    queueAdd: async (command: string) => {
      const { zoneId, audiopath } = parseAudiopathCommand(command, 3);
      await zoneManager.queue.appendUri(zoneId, audiopath);
      return buildResponse(command, 'queueadd', 'ok');
    },

    queueInsert: async (command: string) => {
      const { zoneId, audiopath } = parseAudiopathCommand(command, 3);
      await zoneManager.queue.insertUriAfterCurrent(zoneId, audiopath);
      return buildResponse(command, 'queueinsert', 'ok');
    },

    queueAndPlay: async (command: string) => {
      const { zoneId, audiopath } = parseAudiopathCommand(command, 3);
      const insertedAt = await zoneManager.queue.insertUriAfterCurrent(zoneId, audiopath);
      if (insertedAt >= 0) {
        zoneManager.queue.selectIndex(zoneId, insertedAt);
        zoneManager.handleCommand(zoneId, 'queueplaycurrent');
      }
      return buildResponse(command, 'queueandplay', 'ok');
    },

    queuePlay: (command: string) => {
      // audio/<id>/queue/play/<uid>
      const parts = splitCommand(command);
      const zoneId = parseNumberPart(parts[1], 0);
      const uid = extractPayload(parts.slice(4));
      if (zoneManager.queue.seekInQueue(zoneId, uid)) {
        zoneManager.handleCommand(zoneId, 'queueplaycurrent');
      } else {
        log.debug('queue/play target not in queue', { zoneId, uid });
      }
      return buildResponse(command, 'queue', { play: uid });
    },

    queueMove: (command: string) => {
      // audio/<id>/queue/move/<srcUid>/before/<targetUid>, or audio/<id>/queue/move/<srcUid>/end
      // — the app sends the second form, without `before`, when an item is dropped past the
      // last row.
      const parts = splitCommand(command);
      const zoneId = parseNumberPart(parts[1], 0);
      const beforeIdx = parts.indexOf('before', 4);
      const toEnd = beforeIdx <= 4 && parts.length > 5 && parts[parts.length - 1] === 'end';
      const src =
        beforeIdx > 4
          ? decodeSegment(parts.slice(4, beforeIdx).join('/'))
          : extractPayload(toEnd ? parts.slice(4, -1) : parts.slice(4));
      const target = beforeIdx > 4 ? decodeSegment(parts.slice(beforeIdx + 1).join('/')) : 'end';
      const moved = zoneManager.queue.moveBeforeUniqueId(zoneId, src, target || 'end');
      if (!moved) {
        log.debug('queue/move failed', { zoneId, src, target });
      }
      return buildResponse(command, 'move', 'ok');
    },

    queueRemove: (command: string) => {
      // audio/<id>/queue/remove/<uid>   (also legacy queueremove/<uid>)
      const parts = splitCommand(command);
      const zoneId = parseNumberPart(parts[1], 0);
      const startIdx = parts[2] === 'queue' ? 4 : 3;
      const uid = extractPayload(parts.slice(startIdx));
      zoneManager.queue.removeByUniqueId(zoneId, uid);
      return buildResponse(command, 'remove', { deleted: uid });
    },

    queueClear: (command: string) => {
      const parts = splitCommand(command);
      const zoneId = parseNumberPart(parts[1], 0);
      zoneManager.queue.clear(zoneId);
      return buildResponse(command, 'clear', 'ok');
    },

    queueUndo: (command: string) => {
      const parts = splitCommand(command);
      const zoneId = parseNumberPart(parts[1], 0);
      zoneManager.queue.undo(zoneId);
      return buildResponse(command, 'queueundo', 'ok');
    },

    playlistSave: async (command: string) => {
      // audio/<id>/playlist/save/<name>
      const parts = splitCommand(command);
      const zoneId = parseNumberPart(parts[1], 0);
      const name = decodeSegment(parts.slice(4).join('/'));
      if (!name) {
        return buildResponse(command, 'playlist', [{ action: 'failed' }]);
      }
      const queue = zoneManager.getQueue(zoneId, 0, 10_000);
      const playlist = contentManager.createLocalPlaylist(name);
      const playlistId = Number(playlist.id);
      let added = 0;
      // resolveAddableItems only matches local library items; non-local queue
      // entries (Spotify/bridge) are skipped.
      for (const item of queue.items) {
        if (!item.audiopath) {
          continue;
        }
        added += await contentManager.addItemsToLocalPlaylist(playlistId, item.audiopath);
      }
      const encodedId = encodeLoxoneId(playlistId, BASE_PLAYLIST);
      notifier.notifyPlaylistChanged(
        {
          action: 'create',
          playlistid: encodedId,
          audiopath: encodedId,
          cmd: 'lms',
          user: 'nouser',
          name: playlist.name,
        },
        command,
      );
      log.debug('queue saved as playlist', { zoneId, playlistId, name: playlist.name, added });
      return buildResponse(command, 'playlist', [
        { action: 'save', audiopath: encodedId, playlistid: encodedId, name: playlist.name },
      ]);
    },
  };
}

/** Parses `audio/<id>/<cmd>/<audiopath...>` where the audiopath may contain `/`. */
function parseAudiopathCommand(command: string, pathStart: number): { zoneId: number; audiopath: string } {
  const parts = splitCommand(command);
  return {
    zoneId: parseNumberPart(parts[1], 0),
    audiopath: extractPayload(parts.slice(pathStart)),
  };
}
