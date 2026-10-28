/**
 * Bộ lập lịch dịch. Không phụ thuộc Chrome hay DOM: backend (Translator API) và cache được tiêm vào,
 * nên toàn bộ logic hàng đợi / cache / hủy có thể kiểm thử bằng backend giả.
 *
 * Quy tắc:
 * - Chỉ dịch cửa sổ [anchor, anchor + lookahead) quanh vị trí đang phát, gần nhất trước. Không dịch cả video.
 * - Timestamp của đoạn không bao giờ bị sửa; bản dịch chỉ gắn vào chỉ số đoạn.
 * - Mỗi nội dung nguồn duy nhất chỉ gọi bộ dịch một lần (cache bền + bộ nhớ trong phiên).
 * - Sau dispose() mọi kết quả đến muộn bị bỏ, không ghi đè trạng thái.
 */
import type {
  TranscriptSegment,
  TranslationPhase,
  TranslationSnapshot,
  VyronError,
} from '../shared/types.ts';
import { makeCacheKey, normalizeText } from '../shared/cache-key.ts';

export type BackendAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported-api';
export type BatchItem = { ok: true; text: string } | { ok: false; message: string };

export interface TranslationBackend {
  availability(source: string, target: string): Promise<BackendAvailability>;
  /** Tạo bộ dịch (có thể tải gói ngôn ngữ). Với 'downloadable' phải gọi từ thao tác bấm của người dùng. */
  prepare(source: string, target: string, onProgress: (fraction: number) => void): Promise<void>;
  translateBatch(source: string, target: string, texts: string[]): Promise<BatchItem[]>;
}

export interface TranslationCache {
  get(keys: string[]): Promise<Record<string, string>>;
  set(entries: Array<[string, string]>): Promise<void>;
}

export interface EngineOptions {
  backend: TranslationBackend;
  cache: TranslationCache;
  segments: readonly TranscriptSegment[];
  sourceLanguage: string;
  targetLanguage: string;
  modelId: string;
  lookahead?: number;
  batchSize?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onChange?: () => void;
}

const PENDING = 0;
const DONE = 1;
const FAILED = 2;

function toVyronError(e: unknown): VyronError {
  if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
    const o = e as { code: unknown; message: unknown; hint?: unknown };
    return {
      code: o.code as VyronError['code'],
      message: String(o.message),
      hint: typeof o.hint === 'string' ? o.hint : undefined,
    };
  }
  return { code: 'TRANSLATOR_FAILED', message: e instanceof Error ? e.message : String(e) };
}

export class TranslationEngine {
  private backend: TranslationBackend;
  private cache: TranslationCache;
  private segments: readonly TranscriptSegment[];
  private source: string;
  private target: string;
  private modelId: string;
  private lookahead: number;
  private batchSize: number;
  private maxAttempts: number;
  private sleep: (ms: number) => Promise<void>;
  private onChange: () => void;

  private translations: Array<string | null>;
  private status: Uint8Array;
  private attempts: Uint8Array;
  private memo = new Map<string, string>();

  private phase: TranslationPhase = 'idle';
  private progress = 0;
  private error: VyronError | null = null;
  private doneCount = 0;
  private failedCount = 0;
  private backendCalls = 0;

  private anchor = 0;
  private disposed = false;
  private pumpPromise: Promise<void> | null = null;

  constructor(o: EngineOptions) {
    this.backend = o.backend;
    this.cache = o.cache;
    this.segments = o.segments;
    this.source = o.sourceLanguage;
    this.target = o.targetLanguage;
    this.modelId = o.modelId;
    this.lookahead = o.lookahead ?? 30;
    this.batchSize = o.batchSize ?? 6;
    this.maxAttempts = o.maxAttempts ?? 3;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onChange = o.onChange ?? (() => {});
    this.translations = new Array(o.segments.length).fill(null);
    this.status = new Uint8Array(o.segments.length);
    this.attempts = new Uint8Array(o.segments.length);
    if (this.source === this.target) this.phase = 'not-needed';
  }

  // ---------- Vòng đời ----------
  async init(): Promise<void> {
    if (this.phase === 'not-needed' || this.disposed) return;
    this.setPhase('checking');
    let avail: BackendAvailability;
    try {
      avail = await this.backend.availability(this.source, this.target);
    } catch (e) {
      this.fail(e);
      return;
    }
    if (this.disposed) return;
    if (avail === 'unsupported-api') {
      this.error = {
        code: 'TRANSLATOR_UNSUPPORTED',
        message: 'Chrome này không có Translator API.',
        hint: 'Cần Chrome trên máy tính (Windows/macOS/Linux) bản đủ mới. Kiểm tra chrome://version và cập nhật Chrome.',
      };
      this.setPhase('unsupported');
    } else if (avail === 'unavailable') {
      this.error = {
        code: 'TRANSLATOR_UNAVAILABLE',
        message: `Chrome báo cặp ngôn ngữ ${this.source}→${this.target} không khả dụng trên máy này.`,
        hint: 'Có thể do ngôn ngữ chưa được hỗ trợ hoặc máy không đủ điều kiện phần cứng/dung lượng ổ đĩa.',
      };
      this.setPhase('unsupported');
    } else if (avail === 'available') {
      await this.prepare(false);
    } else {
      this.error = null;
      this.setPhase('needs-download');
    }
  }

  /** Gọi trực tiếp trong trình xử lý click của người dùng (Chrome yêu cầu user activation để tải gói ngôn ngữ). */
  async requestDownload(): Promise<void> {
    if (this.disposed) return;
    if (this.phase !== 'needs-download' && this.phase !== 'error') return;
    await this.prepare(true);
  }

  async retry(): Promise<void> {
    if (this.disposed || this.phase !== 'error') return;
    await this.init();
  }

  dispose(): void {
    this.disposed = true;
  }

  private async prepare(download: boolean): Promise<void> {
    this.progress = 0;
    this.error = null;
    this.setPhase(download ? 'downloading' : 'preparing');
    try {
      await this.backend.prepare(this.source, this.target, (p) => {
        if (this.disposed) return;
        this.progress = Math.max(0, Math.min(1, p));
        this.onChange();
      });
    } catch (e) {
      if (this.disposed) return;
      const err = toVyronError(e);
      this.error = err;
      this.setPhase(err.code === 'TRANSLATOR_NEEDS_ACTIVATION' ? 'needs-download' : 'error');
      return;
    }
    if (this.disposed) return;
    this.error = null;
    this.progress = 1;
    this.setPhase('ready');
    this.kick();
  }

  // ---------- Lập lịch ----------
  /** `index` là đoạn đang hiệu lực hoặc đoạn sắp tới (xem findAnchorIndex). */
  setPlayhead(index: number): void {
    this.anchor = Math.max(0, index);
    this.kick();
  }

  /** Promise hoàn tất khi hàng đợi hiện tại đã xử lý xong (dùng cho kiểm thử). */
  whenIdle(): Promise<void> {
    return this.pumpPromise ?? Promise.resolve();
  }

  private kick(): void {
    if (this.disposed || this.phase !== 'ready' || this.pumpPromise) return;
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null;
    });
  }

  private async pump(): Promise<void> {
    while (!this.disposed && this.phase === 'ready') {
      const batch = this.nextBatch();
      if (batch.length === 0) return;
      let progressed: boolean;
      try {
        progressed = await this.processBatch(batch);
      } catch (e) {
        if (!this.disposed) this.fail(e);
        return;
      }
      if (!progressed && !this.disposed) await this.sleep(500);
    }
  }

  private nextBatch(): number[] {
    const end = Math.min(this.segments.length, this.anchor + this.lookahead);
    const out: number[] = [];
    for (let i = this.anchor; i < end && out.length < this.batchSize; i++) {
      if (this.status[i] === PENDING) out.push(i);
    }
    return out;
  }

  /** Trả true nếu ít nhất một đoạn hoàn tất. Ném lỗi nếu bộ dịch hỏng hẳn. */
  private async processBatch(indices: number[]): Promise<boolean> {
    const key = (t: string) => makeCacheKey(this.modelId, this.source, this.target, t);
    const texts = indices.map((i) => normalizeText(this.segments[i]!.originalText));

    // 1) bộ nhớ trong phiên -> 2) cache bền -> 3) bộ dịch
    const unknown = [...new Set(texts.filter((t) => t && !this.memo.has(t)))];
    if (unknown.length > 0) {
      try {
        const hits = await this.cache.get(unknown.map(key));
        for (const t of unknown) {
          const v = hits[key(t)];
          if (typeof v === 'string') this.memo.set(t, v);
        }
      } catch {
        /* cache lỗi = coi như không có, vẫn dịch bình thường */
      }
    }

    const toTranslate = unknown.filter((t) => !this.memo.has(t));
    if (toTranslate.length > 0) {
      const items = await this.backend.translateBatch(this.source, this.target, toTranslate);
      const entries: Array<[string, string]> = [];
      toTranslate.forEach((t, k) => {
        const it = items[k];
        if (it && it.ok && it.text.trim()) {
          this.memo.set(t, it.text);
          entries.push([key(t), it.text]);
          this.backendCalls++;
        }
      });
      if (entries.length > 0) {
        try {
          await this.cache.set(entries); // kết quả vẫn hợp lệ dù engine đã dispose, nên vẫn lưu
        } catch {
          /* bỏ qua */
        }
      }
    }

    if (this.disposed) return false;

    let progressed = false;
    indices.forEach((i, k) => {
      const t = texts[k]!;
      const v = t ? this.memo.get(t) : '';
      if (v !== undefined) {
        this.translations[i] = v;
        this.status[i] = DONE;
        this.doneCount++;
        progressed = true;
      } else {
        this.attempts[i]!++;
        if (this.attempts[i]! >= this.maxAttempts) {
          this.status[i] = FAILED;
          this.failedCount++;
        }
      }
    });
    this.onChange();
    return progressed;
  }

  private fail(e: unknown): void {
    this.error = toVyronError(e);
    this.setPhase('error');
  }

  private setPhase(p: TranslationPhase): void {
    this.phase = p;
    this.onChange();
  }

  // ---------- Đọc kết quả ----------
  getTranslation(index: number): string | null {
    return this.translations[index] ?? null;
  }

  getAll(): Array<string | null> {
    return this.translations.slice();
  }

  snapshot(): TranslationSnapshot {
    return {
      phase: this.phase,
      progress: this.progress,
      error: this.error,
      total: this.segments.length,
      translatedCount: this.doneCount,
      failedCount: this.failedCount,
      backendCalls: this.backendCalls,
      sourceLanguage: this.source,
      targetLanguage: this.target,
    };
  }
}
