import { normalizeNumbers } from './numbers.ts';

/**
 * Chuẩn hóa văn bản trước khi đưa cho giọng đọc. Trả về chuỗi rỗng nếu không có gì đáng đọc.
 * - Bỏ nhãn âm thanh trong ngoặc vuông: [Music], [âm nhạc], [vỗ tay]... và ký hiệu nhạc ♪ ♫.
 * - Bỏ ký hiệu đổi người nói ">>".
 * - Bỏ ngoặc, ngoặc kép, gạch ngang (giữ nội dung).
 * - Đổi số, tiền, %, giờ, ngày thành chữ (10.000 -> mười nghìn) để không bị đọc từng chữ số.
 * - Dấu câu (. , ; : ! ? …) tính theo từng câu:
 *   + Câu dài (nhiều hơn SHORT_SENTENCE_WORDS từ): GIỮ nguyên dấu câu để giọng đọc ngắt nghỉ bình thường.
 *   + Câu ngắn (tối đa SHORT_SENTENCE_WORDS từ), như "Oh my god. Oh no.": BỎ dấu câu để đọc lướt qua liền mạch.
 *   Dấu nằm GIỮA số (3.5, 1,000) luôn được giữ nguyên để không đọc sai số.
 * Nhãn vẫn hiện trong phụ đề; chỉ không đọc thành tiếng.
 */
/** Mặc định: câu có tối đa chừng này từ thì bỏ dấu câu để đọc liền mạch; dài hơn thì giữ dấu. Người dùng chỉnh bằng thanh kéo trong popup. */
export const SHORT_SENTENCE_WORDS = 5;

const SENTENCE_END = /[.!?…。！？]+(?=\s|$)/g;

/** Bỏ dấu câu ở cuối từ và dấu thừa ở đầu từ (không đụng dấu nằm giữa chữ/số). */
function stripPunctuation(text: string): string {
  return text
    .replace(/[.,;:!?…。，、；：！？]+(?=\s|$)/g, ' ')
    .replace(/(^|\s)[.,;:!?…]+(?=\S)/g, '$1');
}

/** Tách thành từng câu (dấu kết câu nằm cuối câu); câu ngắn bị bỏ dấu câu, câu dài giữ nguyên. */
function applySentencePunctuation(text: string, shortWords: number): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index! + m[0].length;
    parts.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts
    .map((part) => {
      const words = part.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
      return words <= shortWords ? stripPunctuation(part) : part;
    })
    .join('');
}

export function toSpeakable(text: string, skipSoundLabels = true, shortWords = SHORT_SENTENCE_WORDS): string {
  let t = text;
  if (skipSoundLabels) {
    t = t.replace(/\[[^\]]*\]/g, ' ').replace(/[♪♫]/g, ' ');
    if (/^\s*\([^()]*\)\s*$/.test(t)) t = '';
  }
  t = applySentencePunctuation(normalizeNumbers(t), shortWords);
  t = t
    .replace(/(^|\s)>+(?=\s|$)/g, ' ')
    .replace(/["“”„«»()[\]{}]/g, ' ') // ngoặc, ngoặc kép: bỏ ký tự, giữ nội dung
    .replace(/(^|\s)[-–—]+(?=\s|$)|[–—]/g, ' ') // gạch ngang đứng riêng hoặc gạch dài
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\p{L}\p{N}]) ([.,;:!?…])(?=\s|$)/gu, '$1') // số đổi thành chữ có thể để lại khoảng trắng trước dấu
    .trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}
