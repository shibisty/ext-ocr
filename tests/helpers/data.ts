import type { Entry, Item, Job } from '../../src/shared/types.ts';

export const file = (name: string, body = name, lastModified = 1_700_000_000_000, type = 'image/png') =>
  new File([body], name, { type, lastModified });

export const entry = (path: string, body = path, lastModified?: number): Entry =>
  ({ file: file(path.split('/').pop()!, body, lastModified), path });

export function item(p: Partial<Item> & { key: string }): Item {
  return {
    seq: 1, jobId: 1, name: p.key, path: p.key, size: 1, status: 'pending', prio: 0, hasBlob: true, ...p
  };
}

export const job = (p: Partial<Job> & { id: number }): Job =>
  ({ name: 'J', createdAt: p.id, total: 1, startedAt: null, finishedAt: null, ...p });

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
