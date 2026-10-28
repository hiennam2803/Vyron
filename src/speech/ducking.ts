/**
 * Hạ âm lượng video khi giọng dịch đang đọc, rồi trả về mức cũ.
 * - Nhớ âm lượng gốc của người dùng; luôn trả về đúng mức đó.
 * - Nếu người dùng tự kéo âm lượng trong lúc đang hạ, không ghi đè lựa chọn của họ.
 * - Chờ một khoảng ngắn trước khi trả âm lượng để giữa các câu liền nhau không bị lên xuống liên tục.
 * Hạ âm lượng là hạ cả giọng gốc, nhạc và hiệu ứng: không tách riêng được giọng nói.
 */
export interface MediaLike extends EventTarget {
  volume: number;
}
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class VolumeDucker {
  private media: MediaLike;
  private timers: Timers;
  private rampMs: number;
  private saved: number | null = null; // âm lượng gốc của người dùng khi đang hạ
  private pendingRestore: number | null = null; // mức đang được trả về (nếu hạ lại giữa chừng thì lấy mức này, không lấy giá trị dở dang)
  private lastSet = -1;
  private overridden = false;
  private releaseTimer: unknown = null;
  private rampToken = 0;

  constructor(media: MediaLike, opts: { rampMs?: number; timers?: Timers } = {}) {
    this.media = media;
    this.rampMs = opts.rampMs ?? 150;
    this.timers = opts.timers ?? realTimers;
  }

  duck(level: number): void {
    this.clearRelease();
    if (this.saved === null) {
      this.saved = this.pendingRestore ?? this.media.volume;
      this.pendingRestore = null;
      this.overridden = false;
      this.media.addEventListener('volumechange', this.onVolumeChange);
    }
    if (this.overridden) return; // người dùng đã tự chỉnh: để yên
    this.rampTo(clamp01(this.saved * clamp01(level)));
  }

  /** Trả âm lượng sau delayMs; nếu duck() được gọi lại trước đó thì hủy. */
  release(delayMs: number): void {
    if (this.saved === null) return;
    this.clearRelease();
    if (delayMs <= 0) this.restoreNow();
    else this.releaseTimer = this.timers.setTimeout(() => this.restoreNow(), delayMs);
  }

  restoreNow(): void {
    this.clearRelease();
    if (this.saved === null) return;
    const saved = this.saved;
    this.media.removeEventListener('volumechange', this.onVolumeChange);
    this.saved = null;
    if (!this.overridden) {
      this.pendingRestore = saved;
      this.rampTo(saved);
    }
    this.overridden = false;
  }

  dispose(): void {
    this.rampToken++;
    this.restoreNow();
    this.rampToken++;
    if (this.pendingRestore !== null) this.apply(this.pendingRestore); // không để volume kẹt ở mức thấp khi hủy
    this.pendingRestore = null;
  }

  private rampTo(target: number): void {
    const token = ++this.rampToken;
    const from = this.media.volume;
    if (this.rampMs <= 0 || Math.abs(target - from) < 0.01) {
      this.apply(target);
      this.finishRamp(target);
      return;
    }
    const steps = 5;
    let i = 0;
    const step = () => {
      if (token !== this.rampToken || this.overridden) return;
      i++;
      this.apply(from + ((target - from) * i) / steps);
      if (i < steps) this.timers.setTimeout(step, this.rampMs / steps);
      else this.finishRamp(target);
    };
    step();
  }

  private finishRamp(target: number): void {
    if (this.pendingRestore !== null && Math.abs(this.pendingRestore - target) < 1e-9) this.pendingRestore = null;
  }

  private apply(v: number): void {
    const c = clamp01(v);
    this.lastSet = c;
    this.media.volume = c;
  }

  private clearRelease(): void {
    if (this.releaseTimer !== null) {
      this.timers.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  private onVolumeChange = (): void => {
    if (this.saved === null || Math.abs(this.media.volume - this.lastSet) < 0.01) return; // do chính ta đặt
    this.overridden = true; // người dùng tự chỉnh: lấy mức mới làm mức gốc, hủy mọi hiệu ứng chuyển
    this.saved = this.media.volume;
    this.rampToken++;
  };
}
