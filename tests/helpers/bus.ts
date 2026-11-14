// Подменный BroadcastChannel: доставляет сообщения другим экземплярам с тем же именем и записывает всё отправленное.
export class FakeChannel {
  static all: FakeChannel[] = [];
  static posted: { name: string; data: unknown }[] = [];
  static reset() { FakeChannel.all = []; FakeChannel.posted = []; }
  /** Сообщение «от движка» всем открытым каналам. */
  static deliver(name: string, data: unknown) {
    for (const c of FakeChannel.all) if (c.name === name && !c.closed) c.onmessage?.({ data } as MessageEvent);
  }

  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  constructor(readonly name: string) { FakeChannel.all.push(this); }
  postMessage(data: unknown) {
    FakeChannel.posted.push({ name: this.name, data: structuredClone(data) });
    for (const c of FakeChannel.all) if (c !== this && c.name === this.name && !c.closed) c.onmessage?.({ data: structuredClone(data) } as MessageEvent);
  }
  close() { this.closed = true; }
}
