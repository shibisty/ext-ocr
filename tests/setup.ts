// Общая подготовка: свежая IndexedDB на каждый тест.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach } from 'vitest';
import * as DB from '../src/shared/db.ts';

beforeEach(async () => {
  await DB.close();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

afterEach(async () => {
  await DB.close();
});
