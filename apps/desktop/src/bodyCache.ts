import type { EngineMessageDetail } from './types.ts';

/** 超过这个时间就重新向引擎要一次（读/标记状态可能变了）。 */
export const BODY_TTL_MS = 5 * 60_000;

/** 缓存最多留这么多封信…… */
const MAX_ENTRIES = 20;
/** ……并且正文总量不超过这么多字符（约 32 MB 的 UTF-16）。 */
const MAX_CHARS = 16 * 1024 * 1024;

interface Entry {
  detail: EngineMessageDetail;
  /** 取回来的时间，`Date.now()`。 */
  at: number;
  chars: number;
}

function size_of(detail: EngineMessageDetail): number {
  return (detail.htmlBody?.length ?? 0) + (detail.textBody?.length ?? 0);
}

/**
 * 最近读过的邮件正文，按"最近使用"淘汰。
 *
 * 来回翻邮件时正文通常已经在本地库里，但走一次 IPC + 解析还是要几十毫秒；
 * 常见的那几封留在这里，点回去就是立刻出现。服务器上还没下载过的邮件本来
 * 也进不了这个缓存。
 */
export class BodyCache {
  private readonly entries = new Map<number, Entry>();
  private totalChars = 0;
  private readonly capacity: number;
  private readonly maxChars: number;
  private readonly ttlMs: number;

  constructor(capacity = MAX_ENTRIES, maxChars = MAX_CHARS, ttlMs = BODY_TTL_MS) {
    this.capacity = capacity;
    this.maxChars = maxChars;
    this.ttlMs = ttlMs;
  }

  /** 命中就返回并把它挪到"最近使用"那一端。 */
  get(id: number): EngineMessageDetail | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.detail;
  }

  /** 是不是还够新，够新就不用再问引擎。 */
  isFresh(id: number, now = Date.now()): boolean {
    const entry = this.entries.get(id);
    return entry !== undefined && now - entry.at < this.ttlMs;
  }

  set(id: number, detail: EngineMessageDetail, now = Date.now()): void {
    const existing = this.entries.get(id);
    if (existing) {
      this.totalChars -= existing.chars;
      this.entries.delete(id);
    }
    const chars = size_of(detail);
    this.entries.set(id, { detail, at: now, chars });
    this.totalChars += chars;
    this.evict();
  }

  /** 只改一个字段（比如标为已读），不必丢掉整封。 */
  patch(id: number, changes: Partial<EngineMessageDetail>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const detail = { ...entry.detail, ...changes };
    this.totalChars -= entry.chars;
    entry.detail = detail;
    entry.chars = size_of(detail);
    this.totalChars += entry.chars;
  }

  delete(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.totalChars -= entry.chars;
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
    this.totalChars = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get chars(): number {
    return this.totalChars;
  }

  /** 从最久没用的开始丢，直到条数和字数都在上限内。 */
  private evict(): void {
    while (this.entries.size > this.capacity || this.totalChars > this.maxChars) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const entry = this.entries.get(oldest.value);
      if (entry) this.totalChars -= entry.chars;
      this.entries.delete(oldest.value);
    }
  }
}
