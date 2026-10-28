import type { CaptionTrackInfo, TranscriptSegment, TranscriptStats } from '../shared/types.ts';

/** Phần tối thiểu của một đoạn mà các hàm tìm kiếm theo thời gian cần. */
export type TimedSegment = Pick<TranscriptSegment, 'startTime' | 'endTime'>;

export class TranscriptParseError extends Error {
  code = 'PARSE_FAILED' as const;
  constructor(message: string) {
    super(message);
  }
}

interface Json3Seg {
  utf8?: string;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

/**
 * Chuẩn hóa phụ đề định dạng YouTube "json3" thành danh sách đoạn.
 * Không bịa dữ liệu: đoạn rỗng bị bỏ, đoạn thiếu duration được đánh dấu qua stats.estimatedEndCount.
 * Chồng lấn (ASR hay có) luôn được đếm vào stats.overlapCount (tính trên timestamp gốc).
 * Với options.clipOverlaps, endTime bị cắt tại startTime của đoạn kế; giá trị gốc giữ ở rawEndTime.
 */
export function parseJson3(
  body: string,
  sourceLanguage: string,
  options: { clipOverlaps?: boolean } = {},
): { segments: TranscriptSegment[]; stats: TranscriptStats } {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new TranscriptParseError('Nội dung phụ đề không phải JSON hợp lệ.');
  }
  const events = (data as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) {
    throw new TranscriptParseError('JSON phụ đề không có mảng "events".');
  }

  type Raw = { start: number; end: number; text: string; estimated: boolean };
  const raw: Raw[] = [];
  for (const ev of events as Json3Event[]) {
    if (!ev || !Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') continue;
    const text = ev.segs
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const start = ev.tStartMs / 1000;
    const dur = typeof ev.dDurationMs === 'number' && ev.dDurationMs > 0 ? ev.dDurationMs / 1000 : 0;
    raw.push({ start, end: start + dur, text, estimated: dur === 0 });
  }

  raw.sort((a, b) => a.start - b.start); // sort ổn định

  // Bỏ đoạn trùng liên tiếp (cùng thời điểm bắt đầu và cùng nội dung)
  const deduped: Raw[] = [];
  let duplicatesRemoved = 0;
  for (const r of raw) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.text === r.text && Math.abs(prev.start - r.start) < 0.001) {
      duplicatesRemoved++;
      continue;
    }
    deduped.push(r);
  }

  // Ước lượng endTime cho đoạn thiếu duration
  let estimatedEndCount = 0;
  for (let i = 0; i < deduped.length; i++) {
    const cur = deduped[i]!;
    if (!cur.estimated) continue;
    estimatedEndCount++;
    const next = deduped[i + 1];
    cur.end = next && next.start > cur.start ? next.start : cur.start + 2;
  }

  let overlapCount = 0;
  for (let i = 1; i < deduped.length; i++) {
    if (deduped[i]!.start < deduped[i - 1]!.end - 0.001) overlapCount++;
  }

  const rawEnds = deduped.map((r) => r.end);
  let clippedCount = 0;
  if (options.clipOverlaps) {
    for (let i = 0; i < deduped.length - 1; i++) {
      const cur = deduped[i]!;
      const next = deduped[i + 1]!;
      if (next.start > cur.start && cur.end > next.start) {
        cur.end = next.start;
        clippedCount++;
      }
    }
  }

  const segments: TranscriptSegment[] = deduped.map((r, i) => ({
    id: `s${i}`,
    startTime: r.start,
    endTime: r.end,
    rawEndTime: rawEnds[i]!,
    originalText: r.text,
    sourceLanguage,
  }));

  const stats: TranscriptStats = {
    count: segments.length,
    overlapCount,
    duplicatesRemoved,
    estimatedEndCount,
    clippedCount,
    firstStart: segments.length ? segments[0]!.startTime : 0,
    lastEnd: segments.length ? Math.max(...segments.map((s) => s.endTime)) : 0,
  };
  return { segments, stats };
}

/**
 * Tìm đoạn chứa `time` (startTime <= time < endTime). Trả -1 nếu đang ở khoảng trống.
 * Khi có chồng lấn, ưu tiên đoạn bắt đầu muộn nhất đang còn hiệu lực.
 * Yêu cầu `segments` đã sắp theo startTime (parseJson3 đảm bảo).
 */
export function findSegmentIndex(segments: readonly TimedSegment[], time: number): number {
  if (segments.length === 0 || !(time >= 0)) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.startTime <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = found, steps = 0; i >= 0 && steps < 8; i--, steps++) {
    if (time < segments[i]!.endTime) return i;
  }
  return -1;
}

/** Ưu tiên: track thủ công cùng ngôn ngữ > tự động cùng ngôn ngữ > track thủ công bất kỳ > track đầu. */
export function pickDefaultTrackIndex(
  tracks: readonly Pick<CaptionTrackInfo, 'languageCode' | 'kind'>[],
  preferredLang = 'en',
): number {
  const base = (l: string) => l.toLowerCase().split('-')[0];
  let i = tracks.findIndex((t) => base(t.languageCode) === preferredLang && t.kind === 'manual');
  if (i >= 0) return i;
  i = tracks.findIndex((t) => base(t.languageCode) === preferredLang);
  if (i >= 0) return i;
  i = tracks.findIndex((t) => t.kind === 'manual');
  if (i >= 0) return i;
  return tracks.length ? 0 : -1;
}

/**
 * Chỉ số đoạn cần dịch/đọc tiếp theo: đoạn đang hiệu lực, hoặc nếu đang ở khoảng trống thì đoạn sắp tới.
 * Trả về segments.length nếu đã qua hết phụ đề.
 */
export function findAnchorIndex(segments: readonly TimedSegment[], time: number): number {
  if (!(time >= 0)) return 0;
  const cur = findSegmentIndex(segments, time);
  if (cur >= 0) return cur;
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.startTime > time) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
