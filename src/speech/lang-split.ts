/**
 * Tách văn bản (đã chuẩn hóa) thành các đoạn theo ngôn ngữ để mỗi đoạn dùng đúng giọng:
 * từ tiếng Anh xen trong câu tiếng Việt ("electric logo", "YouTube", "CEO") được đọc bằng giọng tiếng Anh
 * thay vì bị đọc theo vần tiếng Việt ("e le chích lo go").
 *
 * Nhận diện: tiếng Việt luôn có dấu hoặc là âm tiết hợp lệ. Từ chỉ gồm chữ cái ASCII mà KHÔNG thành âm tiết tiếng Việt
 * hợp lệ (electric, logo, video) là tiếng Anh. Từ mơ hồ (an, tin, the) chỉ bị coi là tiếng Anh khi là từ chức năng ngắn (the, to, in...) nằm trong cụm có từ chắc chắn tiếng Anh.
 */

export type Lang = 'vi' | 'en';
export interface SpeechPart {
  text: string;
  lang: Lang;
}

const ONSET = '(?:ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|[bcdghklmnprstvx])';
const NUCLEUS = '(?:uye|uyu|uya|yeu|ieu|uoi|uai|uay|uao|oai|oao|oay|oeo|ai|ao|au|ay|eo|ia|ie|iu|oa|oe|oi|ua|ue|ui|uo|uy|ya|ye|[aeiouy])';
const CODA = '(?:ch|ng|nh|[cmnpt])';
const VI_PLAIN = new RegExp(`^${ONSET}?${NUCLEUS}${CODA}?$`);
const VI_MARKED = /[ăâêôơưđàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
const NON_ASCII = /[^\x00-\x7F]/;

/** Từ chức năng tiếng Anh ngắn: nếu nằm trong cụm tiếng Anh thì đọc bằng giọng Anh. */
const EN_FUNCTION = new Set(['the', 'a', 'an', 'to', 'in', 'on', 'at', 'it', 'he', 'be', 'so', 'do', 'no', 'go', 'me', 'i', 'am', 'up', 'us']);
/** Từ viết tắt đọc như một từ, không đánh vần. */
const ACRONYM_WORDS = new Set(['NASA', 'NATO', 'COVID', 'OPEC', 'UNESCO', 'UNICEF', 'FIFA', 'ASEAN', 'LASER', 'RADAR', 'SARS', 'WIFI', 'LEGO', 'IKEA', 'PIXAR']);

/**
 * Từ mượn đã quen thuộc trong tiếng Việt: giọng Việt đọc chấp nhận được. Cụm tiếng Anh chỉ gồm những từ này thì giữ nguyên
 * giọng Việt để KHỎI phải đổi giọng (mỗi lần đổi giọng Chrome có một khoảng hở ngắn).
 */
const LOANWORDS = new Set(['video', 'radio', 'taxi', 'pizza', 'karaoke', 'menu', 'hotel', 'internet', 'online', 'offline', 'game', 'app', 'laptop', 'wifi', 'show', 'shop']);

type Kind = 'vi' | 'amb' | 'en';

const core = (tok: string) => tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

function classify(tok: string): Kind {
  const c = core(tok);
  if (!c) return 'vi';
  if (VI_MARKED.test(c) || NON_ASCII.test(c)) return 'vi';
  if (!/[A-Za-z]/.test(c)) return 'vi';
  if (/\d/.test(c)) return 'en'; // mp3, iPhone15, 2nd, 1990s
  const letters = c.replace(/[^A-Za-z]/g, '');
  if (c.includes("'")) return 'en'; // don't, it's
  if (letters.length >= 2 && letters === letters.toUpperCase()) return 'en'; // AI, CEO, GPT
  if (letters.length === 1) {
    if (/[aeiouyAEIOUY]/.test(letters)) return 'amb';
    return letters === letters.toUpperCase() ? 'en' : 'vi';
  }
  const lower = letters.toLowerCase();
  if (/([aeiouy])\1/.test(lower)) return 'en'; // see, book, too
  return VI_PLAIN.test(lower) ? 'amb' : 'en';
}

/** Đọc các từ viết tắt in hoa thành từng chữ cái ("CEO" -> "C E O"), trừ những từ đọc nguyên như NASA. */
function spellAcronyms(text: string): string {
  return text.replace(/\b[A-Z]{2,5}\b/g, (w) => (ACRONYM_WORDS.has(w) ? w : [...w].join(' ')));
}

export function splitByLanguage(text: string): SpeechPart[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const kinds = tokens.map(classify);
  const isEn: boolean[] = kinds.map((k) => k === 'en');

  // Cụm liên tiếp gồm token mơ hồ/tiếng Anh: chỉ khi có ít nhất một từ chắc chắn tiếng Anh thì các từ chức năng
  // ngắn trong cụm (the, to, in...) mới được đọc bằng giọng Anh. Từ mơ hồ khác (cho, tin, ban...) vẫn là tiếng Việt.
  let i = 0;
  while (i < tokens.length) {
    if (kinds[i] === 'vi') {
      i++;
      continue;
    }
    let j = i;
    while (j < tokens.length && kinds[j] !== 'vi') j++;
    if (kinds.slice(i, j).includes('en')) {
      for (let k = i; k < j; k++) {
        if (kinds[k] === 'amb' && EN_FUNCTION.has(core(tokens[k]!).toLowerCase())) isEn[k] = true;
      }
    }
    i = j;
  }

  // Cụm tiếng Anh chỉ gồm từ mượn quen thuộc: không đáng đổi giọng.
  for (let k = 0; k < tokens.length; ) {
    if (!isEn[k]) {
      k++;
      continue;
    }
    let e = k;
    while (e < tokens.length && isEn[e]) e++;
    if (tokens.slice(k, e).every((t) => LOANWORDS.has(core(t).toLowerCase()))) for (let x = k; x < e; x++) isEn[x] = false;
    k = e;
  }

  const parts: SpeechPart[] = [];
  tokens.forEach((tok, k) => {
    const lang: Lang = isEn[k] ? 'en' : 'vi';
    const last = parts[parts.length - 1];
    if (last && last.lang === lang) last.text += ` ${tok}`;
    else parts.push({ text: tok, lang });
  });
  return parts.map((p) => (p.lang === 'en' ? { ...p, text: spellAcronyms(p.text) } : p));
}
