// Минимальная подделка chrome.* для тестов: события с addListener/emit и шпионы на вызовы.
import { vi } from 'vitest';

export interface FakeEvent<A extends unknown[]> {
  addListener(fn: (...a: A) => unknown): void;
  emit(...a: A): unknown[];
  listeners: ((...a: A) => unknown)[];
}

export function fakeEvent<A extends unknown[] = unknown[]>(): FakeEvent<A> {
  const listeners: ((...a: A) => unknown)[] = [];
  return { listeners, addListener: (fn) => { listeners.push(fn); }, emit: (...a) => listeners.map((fn) => fn(...a)) };
}

export function makeChrome() {
  const contexts: unknown[] = [];
  const chrome = {
    runtime: {
      getURL: (p: string) => `chrome-extension://test/${p}`,
      getContexts: vi.fn(async () => contexts),
      sendMessage: vi.fn(async (_m: unknown) => ({ ok: true })),
      onStartup: fakeEvent<[]>(),
      onInstalled: fakeEvent<[]>(),
      onMessage: fakeEvent<[unknown, unknown, (r: unknown) => void]>()
    },
    offscreen: { createDocument: vi.fn(async () => { contexts.push({ contextType: 'OFFSCREEN_DOCUMENT' }); }) },
    contextMenus: { create: vi.fn(), onClicked: fakeEvent<[unknown, unknown]>() },
    power: { requestKeepAwake: vi.fn(), releaseKeepAwake: vi.fn() },
    sidePanel: { open: vi.fn(async (_o: unknown) => {}) },
    tabs: { create: vi.fn(async (_o: unknown) => ({})) },
    windows: { getCurrent: vi.fn(async () => ({ id: 7 })) }
  };
  return { chrome, contexts };
}

export type FakeChrome = ReturnType<typeof makeChrome>['chrome'];

export function installChrome() {
  const made = makeChrome();
  (globalThis as unknown as { chrome: FakeChrome }).chrome = made.chrome;
  return made;
}
