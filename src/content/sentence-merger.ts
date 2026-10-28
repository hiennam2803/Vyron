import type { TranscriptSegment } from '../shared/types.ts';

/**
 * Phụ đề của YouTube (nhất là phụ đề tự động) bị cắt theo độ rộng màn hình hoặc theo nhịp thở chứ không theo câu,
 * ví dụ "Chúng ta nên bắt" | "đầu từ đâu nhỉ?". Nếu dịch và đọc từng mảnh thì:
 *   - bản dịch sai vì thiếu ngữ cảnh,
 *   - giọng đọc dừng ngay giữa câu.
 * Bộ gộp này nối các mảnh liền nhau thành một câu trước khi dịch/đọc. Timestamp được giữ trung thực:
 * câu gộp bắt đầu ở mảnh đầu và kết thúc ở mảnh cuối.
 */

export interface MergeOptions {
  /** Khoảng lặng tối đa (giây) giữa hai mảnh để vẫn coi là cùng một câu. */
  maxGap: number;
  /** Khoảng lặng tối đa khi mảnh trước đang dang dở (kết thúc bằng từ nối như "the", "and"). */
  maxGapDangling: number;
  /** Số từ tối đa của một câu gộp (ngoài trường hợp dang dở). */
  maxWords: number;
  /** Số từ tuyệt đối tối đa, kể cả khi câu đang dang dở. */
  hardMaxWords: number;
  /** Thời lượng tối đa (giây) của một câu gộp, để không đọc trễ so với video. */
  maxDuration: number;
  /** Thời lượng tuyệt đối tối đa (giây). */
  hardMaxDuration: number;
}

export const DEFAULT_MERGE_OPTIONS: MergeOptions = {
  maxGap: 0.8,
  maxGapDangling: 1.6,
  maxWords: 24,
  hardMaxWords: 34,
  maxDuration: 9,
  hardMaxDuration: 13,
};

// Từ không bao giờ đứng cuối câu: nếu mảnh kết thúc bằng từ này thì câu chắc chắn còn tiếp.
const DANGLING: Record<string, ReadonlySet<string>> = {
  en: new Set(
    (
      'a an the and or but so because if when while that which who whom whose of to in on at by for with from into onto over under ' +
      'about as than then is are was were be been am do does did have has had will would can could should may might must ' +
      'not no my your his her its our their this these those i we you they he she it there here also just very really more most ' +
      "i'm you're we're they're he's she's it's that's there's i'll you'll we'll they'll i've you've we've they've " +
      "don't doesn't didn't can't won't isn't aren't wasn't weren't gonna wanna gotta kind sort lot bit"
    ).split(' '),
  ),
  vi: new Set(
    (
      'và của là thì mà để với những các một cho trong ở tại từ đến như nếu khi vì nên nhưng hoặc cũng đã đang sẽ rất ' +
      'này kia đó ấy không chưa chẳng bị được'
    ).split(' '),
  ),
};

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'vs', 'st', 'jr', 'sr', 'inc', 'ltd', 'no', 'e.g', 'i.e', 'u.s', 'a.m', 'p.m']);

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
const SOUND_LABEL = /^\s*(\[[^\]]*\]|\([^()]*\)|[♪♫\s]+)\s*$/;
const SPEAKER_CHANGE = /^\s*>>/;

const wordsOf = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Mảnh này có kết thúc một câu thật sự không (bỏ qua chữ viết tắt như "Dr." và số thứ tự). */
export function endsSentence(text: string): boolean {
  const t = text.trim();
  if (!SENTENCE_END.test(t)) return false;
  if (!/\.["'”’)\]]*$/.test(t)) return true; // ! ? … luôn là hết câu
  const last = wordsOf(t).pop() ?? '';
  const bare = last.replace(/[^\p{L}\p{N}.]/gu, '').replace(/\.+$/, '').toLowerCase();
  if (ABBREVIATIONS.has(bare)) return false;
  if (/^\p{L}$/u.test(bare) && bare !== 'i' && bare !== 'a') return false; // "J." trong tên người
  return true;
}

/** Mảnh này có kết thúc bằng một từ chắc chắn chưa hết câu không (the, and, và, của...). */
export function endsDangling(text: string, lang: string): boolean {
  const set = DANGLING[lang.toLowerCase().split('-')[0] ?? ''];
  if (!set) return false;
  const last = wordsOf(text).pop();
  if (!last) return false;
  const bare = last.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  return set.has(bare);
}

function isLabel(text: string): boolean {
  return SOUND_LABEL.test(text);
}

export interface MergeResult {
  segments: TranscriptSegment[];
  /** Số mảnh gốc trước khi gộp. */
  sourceCount: number;
  /** Số câu gộp từ 2 mảnh trở lên. */
  mergedGroups: number;
}

export function mergeIntoSentences(
  input: readonly TranscriptSegment[],
  lang: string,
  options: Partial<MergeOptions> = {},
): MergeResult {
  const o: MergeOptions = { ...DEFAULT_MERGE_OPTIONS, ...options };
  const out: TranscriptSegment[] = [];
  let mergedGroups = 0;
  let groupSize = 0;

  let cur: TranscriptSegment | null = null;
  let curWords = 0;

  const flush = () => {
    if (!cur) return;
    out.push({ ...cur, id: `s${out.length}` });
    if (groupSize > 1) mergedGroups++;
    cur = null;
    groupSize = 0;
  };

  for (const seg of input) {
    if (!cur) {
      cur = { ...seg };
      curWords = wordsOf(seg.originalText).length;
      groupSize = 1;
      continue;
    }
    const nextWords = wordsOf(seg.originalText).length;
    const gap = seg.startTime - cur.endTime;
    const words = curWords + nextWords;
    const duration = Math.max(seg.endTime, cur.endTime) - cur.startTime;
    const dangling = endsDangling(cur.originalText, lang);

    const blocked =
      endsSentence(cur.originalText) || // câu đã khép lại
      isLabel(cur.originalText) || // [Music], ♪ không gộp với lời
      isLabel(seg.originalText) ||
      SPEAKER_CHANGE.test(seg.originalText); // đổi người nói là câu mới
    const gapOk = gap <= (dangling ? o.maxGapDangling : o.maxGap);
    const sizeOk = dangling
      ? words <= o.hardMaxWords && duration <= o.hardMaxDuration
      : words <= o.maxWords && duration <= o.maxDuration;

    if (!blocked && gapOk && sizeOk) {
      cur.originalText = `${cur.originalText} ${seg.originalText}`.replace(/\s+/g, ' ').trim();
      cur.endTime = Math.max(cur.endTime, seg.endTime);
      cur.rawEndTime = Math.max(cur.rawEndTime, seg.rawEndTime);
      curWords = words;
      groupSize++;
    } else {
      flush();
      cur = { ...seg };
      curWords = nextWords;
      groupSize = 1;
    }
  }
  flush();

  return { segments: out, sourceCount: input.length, mergedGroups };
}
