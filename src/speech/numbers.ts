/**
 * Chuyển số, tiền, phần trăm, giờ, ngày, đơn vị trong văn bản tiếng Việt thành chữ để giọng đọc không đọc từng chữ số
 * ("10.000" -> "mười nghìn", chứ không phải "một không không không không").
 * Quy ước dấu: nhóm đúng 3 chữ số sau dấu chấm/phẩy là hàng nghìn (10.000, 1,000); còn lại là số thập phân (3,5 / 3.5).
 */

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const SCALES = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];
const MAX_DIGITS = 15;

function readGroup(n: number, full: boolean): string {
  const h = Math.floor(n / 100);
  const t = Math.floor(n / 10) % 10;
  const u = n % 10;
  const out: string[] = [];
  if (h > 0 || (full && (t > 0 || u > 0))) out.push(`${DIGITS[h]} trăm`);
  if (t > 1) out.push(`${DIGITS[t]} mươi`);
  else if (t === 1) out.push('mười');
  else if (u > 0 && (h > 0 || full)) out.push('linh');
  if (u > 0) {
    if (t >= 2 && u === 1) out.push('mốt');
    else if (t >= 1 && u === 5) out.push('lăm');
    else out.push(DIGITS[u]!);
  }
  return out.join(' ');
}

/** Đọc từng chữ số: dùng cho số điện thoại, mã, số có số 0 đứng đầu, số quá dài. */
export function digitsToWords(s: string): string {
  return [...s].map((c) => DIGITS[Number(c)] ?? c).join(' ');
}

/** Số nguyên không dấu -> chữ (tối đa 15 chữ số). */
export function integerToWords(digits: string): string {
  const s = digits.replace(/^0+(?=\d)/, '');
  if (/^0$/.test(s)) return 'không';
  if (s.length > MAX_DIGITS) return digitsToWords(digits);
  const groups: number[] = [];
  for (let end = s.length; end > 0; end -= 3) groups.unshift(Number(s.slice(Math.max(0, end - 3), end)));
  const out: string[] = [];
  let first = true;
  groups.forEach((g, i) => {
    if (g === 0) return;
    const scale = SCALES[groups.length - 1 - i] ?? '';
    out.push(`${readGroup(g, !first)}${scale ? ` ${scale}` : ''}`);
    first = false;
  });
  return out.join(' ');
}

function plainInt(s: string): string {
  if ((s.length > 1 && s.startsWith('0')) || s.length > MAX_DIGITS) return digitsToWords(s);
  return integerToWords(s);
}

function fraction(s: string): string {
  return s.length <= 2 && !s.startsWith('0') ? integerToWords(s) : digitsToWords(s);
}

/** Một cụm số (có thể kèm . , :) -> chữ. */
export function numberTokenToWords(tok: string): string {
  const time = /^(\d{1,2}):(\d{2})$/.exec(tok);
  if (time) {
    const [, h, m] = time as unknown as [string, string, string];
    const mins = m === '00' ? '' : m.startsWith('0') ? ` không ${DIGITS[Number(m[1])]}` : ` ${integerToWords(m)}`;
    return `${plainInt(h)} giờ${mins}`;
  }
  if (tok.includes(':')) return tok.split(':').map(plainInt).join(' ');
  if (!/[.,]/.test(tok)) return plainInt(tok);

  if (tok.includes('.') && tok.includes(',')) {
    const last = Math.max(tok.lastIndexOf('.'), tok.lastIndexOf(','));
    return `${plainInt(tok.slice(0, last).replace(/[.,]/g, ''))} phẩy ${fraction(tok.slice(last + 1))}`;
  }
  const sep = tok.includes('.') ? '.' : ',';
  const parts = tok.split(sep) as [string, ...string[]];
  const thousands = parts.slice(1).every((p) => p.length === 3) && parts[0].length <= 3 && !parts[0].startsWith('0');
  if (thousands) return plainInt(parts.join(''));
  if (parts.length === 2) return `${plainInt(parts[0])} phẩy ${fraction(parts[1]!)}`;
  return parts.map(plainInt).join(sep === '.' ? ' chấm ' : ' ');
}

const UNITS: Record<string, string> = {
  'km/h': 'ki lô mét trên giờ',
  km: 'ki lô mét',
  kg: 'ki lô gam',
  cm: 'xen ti mét',
  mm: 'mi li mét',
  ml: 'mi li lít',
  mg: 'mi li gam',
  GB: 'gi ga bai',
  MB: 'mê ga bai',
  TB: 'tê ra bai',
  GHz: 'gi ga héc',
  MHz: 'mê ga héc',
  kW: 'ki lô oát',
  đ: 'đồng',
  '₫': 'đồng',
};
const CURRENCY: Record<string, string> = { $: 'đô la', 'US$': 'đô la', '€': 'ơ rô', '£': 'bảng Anh' };
const MAGNITUDE: Record<string, string> = { k: 'nghìn', m: 'triệu', b: 'tỷ' };

const NUMBER_RE =
  /(US\$|[$€£])?(?<![\p{L}\d.,:])(\d+(?:[.,:]\d+)*)(?:(\s?%)|\s?(km\/h|km|kg|cm|mm|ml|mg|GB|MB|TB|GHz|MHz|kW|đ|₫)(?![\p{L}\d])|°([CF])|([kKmMbB])(?![\p{L}\d]))?(?![\p{L}\d])/gu;

export function normalizeNumbers(text: string): string {
  return text
    .replace(/\bUSD\b/g, 'đô la Mỹ')
    .replace(/\bVND\b/g, 'đồng')
    .replace(/\bEUR\b/g, 'ơ rô')
    .replace(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g, (_m, d: string, mo: string, y: string) =>
      `ngày ${plainInt(d)} tháng ${plainInt(mo)} năm ${plainInt(y)}`,
    )
    .replace(/(^|\s)-(?=\d)/g, '$1âm ')
    .replace(/(?<=\p{L})-(?=\d)/gu, ' ') // GPT-4 -> GPT 4
    .replace(/(?<![\d-])(\d[\d.,]*)\s?[-–—]\s?(\d[\d.,]*)(?![\d-])/g, '$1 đến $2')
    .replace(
      NUMBER_RE,
      (_m, cur?: string, num?: string, pct?: string, unit?: string, deg?: string, mag?: string) => {
        let w = numberTokenToWords(num ?? '');
        if (mag) w += ` ${MAGNITUDE[mag.toLowerCase()]}`;
        if (pct) w += ' phần trăm';
        if (unit) w += ` ${UNITS[unit]}`;
        if (deg) w += ` độ ${deg === 'C' ? 'xê' : 'ép'}`;
        if (cur) w += ` ${CURRENCY[cur]}`;
        return ` ${w} `;
      },
    )
    .replace(/(?<=\s)đ(?=\s|$)/g, 'đồng') // "10k đ"
    .replace(/\s*&\s*/g, ' và ')
    .replace(/\s+/g, ' ')
    .trim();
}
