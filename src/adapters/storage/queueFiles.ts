import type {
  QueueFiles,
  StoredQueueItems,
  StoredQueueState,
} from '@/application/zones/queue/queuePersistence';
import { readJson, resolveDataDir, writeJson } from '@/shared/utils/file';

function queueFile(zoneId: number, part: 'items' | 'state'): string {
  return resolveDataDir('queues', `${zoneId}.${part}.json`);
}

/** Zone queues as two JSON files per zone under `data/queues`. */
export function createQueueFiles(): QueueFiles {
  return {
    readItems: async (zoneId) => (await readJson<StoredQueueItems>(queueFile(zoneId, 'items'))) ?? null,
    readState: async (zoneId) => (await readJson<StoredQueueState>(queueFile(zoneId, 'state'))) ?? null,
    writeItems: (zoneId, data) => writeJson(queueFile(zoneId, 'items'), data),
    writeState: (zoneId, data) => writeJson(queueFile(zoneId, 'state'), data),
  };
}
