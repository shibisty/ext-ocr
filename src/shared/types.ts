// Общие типы: записи в IndexedDB, настройки, сообщения между движком и интерфейсами.

export type Status = 'pending' | 'processing' | 'done' | 'error';
export type EngineName = 'paddle' | 'tesseract';
export type EngineSetting = 'auto' | EngineName;

/** Состояние перевода записи. '' — ещё не переводили. */
export type TState = '' | 'ok' | 'same' | 'unknown' | 'unsupported' | 'need-download' | 'error';

/** Что нужно скачать, чтобы перевод заработал. */
export type NeedSpec = { kind: 'detector' } | { kind: 'pair'; from: string; to: string };
export interface NeedInfo { id: string; label: string; spec: NeedSpec }

/** Запись очереди (лёгкая, без картинки — она в сторе blobs). */
export interface Item {
  key: string;
  seq: number;
  jobId: number | null;
  name: string;
  path: string;
  size: number;
  status: Status;
  prio: number;
  hasBlob: boolean;
  engine?: EngineName | null;
  conf?: number | null;
  text?: string;
  warn?: string;
  error?: string;
  lang?: string;
  translation?: string;
  tState?: TState;
  tTarget?: string;
  tErr?: string;
  tNeed?: NeedInfo | null;
  thumb?: string;
  ms?: number | null;
  doneAt?: number | null;
}

/** Задание = одно добавление файлов (история). */
export interface Job {
  id: number;
  name: string;
  createdAt: number;
  total: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Settings {
  engine: EngineSetting;
  lang: string;
  translate: boolean;
  target: string;
  keepImages: boolean;
}

export interface Entry { file: File; path: string }

/** Состояние фонового движка, которое он рассылает интерфейсам. */
export interface EngineState {
  paused: boolean;
  running: boolean;
  current: { key: string; name: string; text: string } | null;
  remaining: number;
  sessionDone: number;
  sessionMs: number;
  canTranslate: boolean;
}

export type Command =
  | { cmd: 'wake' }
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'retryErrors' }
  | { cmd: 'redoAll'; jobId?: number | null }
  | { cmd: 'redoOne'; key: string }
  | { cmd: 'clear' }
  | { cmd: 'deleteJob'; jobId: number }
  | { cmd: 'translateMissing' };

export type CommandName = Command['cmd'];
/** Дополнительные поля команды (без самого имени). */
export type CommandArgs<C extends CommandName> = Omit<Extract<Command, { cmd: C }>, 'cmd'>;

/** Сообщения в BroadcastChannel('ocr'). */
export type BusMessage =
  | { t: 'hello' }
  | ({ t: 'cmd' } & Command)
  | ({ t: 'state' } & EngineState)
  | { t: 'item'; item: Item }
  | { t: 'reload' }
  | { t: 'jobs' }
  | { t: 'toast'; text: string }
  | { t: 'settings' };

/** Сообщения в service worker (chrome.runtime.sendMessage). */
export type RuntimeMessage = { t: 'ensureEngine' } | { t: 'awake'; on: boolean };
export interface EnsureEngineReply { ok: boolean; error?: string }

export const CHANNEL = 'ocr';
