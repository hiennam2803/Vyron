/**
 * Logic thuần về nhịp đọc: ước lượng thời gian đọc, tự hiệu chỉnh theo giọng thật, tính tốc độ cần thiết.
 * Không phụ thuộc trình duyệt nên kiểm thử được hoàn toàn.
 */

/** Số "âm tiết" ước lượng của văn bản. Tiếng Việt mỗi từ là một âm tiết; số được đọc dài hơn chữ số viết. */
export function countSpeechUnits(text: string): number {
  const tokens = text.split(/\s+/).filter(Boolean);
  let units = 0;
  for (const tok of tokens) {
    const digits = tok.replace(/\D/g, '').length;
    units += digits >= 2 ? Math.max(2, Math.ceil(digits * 1.2)) : 1;
  }
  return units;
}

export const RATE_MIN = 1;
/** Trần tốc độ khi đang đồng bộ bình thường: vẫn nghe rõ chữ. */
export const RATE_SOFT = 1.3;
/** Trần tốc độ khi phải bắt kịp video. */
export const RATE_HARD = 1.6;

const WPS_DEFAULT = 3.6; // âm tiết/giây ở tốc độ 1.0, giá trị khởi đầu trước khi đo được giọng thật
const WPS_MIN = 1.5;
const WPS_MAX = 7;
const LATENCY_DEFAULT_MS = 250;

/**
 * Ghi nhớ tốc độ đọc thật của giọng đang dùng (đo từ onstart → onend) và độ trễ khởi động.
 * Dùng trung bình trượt: nhanh ở vài câu đầu, ổn định về sau.
 */
export class PaceModel {
  private wps = WPS_DEFAULT;
  private samples = 0;
  private latencyMs = LATENCY_DEFAULT_MS;
  private latencySamples = 0;

  get unitsPerSecond(): number {
    return this.wps;
  }
  get startLatencySeconds(): number {
    return Math.min(0.6, Math.max(0.05, this.latencyMs / 1000));
  }
  get sampleCount(): number {
    return this.samples;
  }

  /** Thời gian (giây) để đọc `units` âm tiết ở tốc độ `rate`. */
  estimateSeconds(units: number, rate = 1): number {
    return units / (this.wps * Math.max(0.1, rate));
  }

  /** Ghi nhận một câu đã đọc xong thật sự. Câu quá ngắn bị bỏ qua vì đo không chính xác. */
  recordUtterance(units: number, rate: number, durationMs: number): void {
    if (units < 4 || !(durationMs > 300) || !(rate > 0)) return;
    const measured = units / (durationMs / 1000) / rate;
    if (!Number.isFinite(measured)) return;
    const clamped = Math.min(WPS_MAX, Math.max(WPS_MIN, measured));
    const alpha = this.samples < 3 ? 0.5 : 0.25;
    this.wps = this.wps * (1 - alpha) + clamped * alpha;
    this.samples++;
  }

  recordLatency(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > 3000) return;
    const alpha = this.latencySamples < 2 ? 0.6 : 0.3;
    this.latencyMs = this.latencyMs * (1 - alpha) + ms * alpha;
    this.latencySamples++;
  }

  reset(): void {
    this.wps = WPS_DEFAULT;
    this.samples = 0;
    this.latencyMs = LATENCY_DEFAULT_MS;
    this.latencySamples = 0;
  }
}

export interface RatePlan {
  /** Tốc độ cần để đọc xong đúng hạn (chưa làm tròn, chưa kẹp). */
  needed: number;
  /** Tốc độ sẽ dùng, đã kẹp và làm mượt. */
  rate: number;
  /** Có đọc kịp ngay cả ở tốc độ trần hay không. */
  fits: boolean;
  /** Thời gian đọc dự kiến (giây thực) ở tốc độ đã chọn. */
  expectedSeconds: number;
}

/**
 * Chọn tốc độ để đọc `units` âm tiết trong `availableSeconds` (giây thực, đã trừ độ trễ khởi động).
 * - Không bao giờ chậm hơn RATE_MIN: thừa thời gian thì đọc tự nhiên rồi chờ.
 * - Tăng tốc ngay khi cần, nhưng giảm từ từ để nghe không bị giật.
 */
export function planRate(opts: {
  model: PaceModel;
  units: number;
  availableSeconds: number;
  previousRate: number;
  ceiling: number;
}): RatePlan {
  const { model, units, previousRate, ceiling } = opts;
  const available = Math.max(0.3, opts.availableSeconds);
  const needed = model.estimateSeconds(units, 1) / available;
  const floor = Math.max(RATE_MIN, previousRate - 0.15); // giảm tối đa 0.15 mỗi câu
  const target = Math.max(needed, floor);
  const rate = Math.round(Math.min(ceiling, Math.max(RATE_MIN, target)) * 20) / 20;
  return {
    needed,
    rate,
    fits: needed <= ceiling + 1e-9,
    expectedSeconds: model.estimateSeconds(units, rate),
  };
}
