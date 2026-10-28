import type { VoiceInfo, VoiceStatus } from '../shared/types.ts';

const isVietnamese = (v: VoiceInfo, prefix: string) => v.lang.toLowerCase().replace('_', '-').startsWith(prefix);

export function vietnameseVoices<T extends VoiceInfo>(voices: readonly T[], langPrefix = 'vi'): T[] {
  return voices.filter((v) => isVietnamese(v, langPrefix));
}

/** Bỏ dấu, viết thường, chỉ giữ chữ và số: "Hoài My" và "Microsoft HoaiMy Online (Natural)" đều chứa "hoaimy". */
const squash = (name: string) =>
  name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Thứ tự ưu tiên khi tự chọn giọng Việt: Hoài My, rồi Nam Minh (hai giọng Online (Natural) của Edge, qua mạng),
 * rồi Microsoft An (giọng trên máy), rồi giọng trên máy khác, cuối cùng mới là giọng qua mạng khác.
 */
function voiceRank(v: VoiceInfo): number {
  const n = squash(v.name);
  if (n.includes('hoaimy')) return 0;
  if (n.includes('namminh')) return 1;
  if (/microsoft an(?![a-z])/i.test(v.name)) return 2;
  return v.localService ? 3 : 4;
}

/**
 * Chọn giọng đọc. Giọng người dùng chọn tay được dùng trước; còn lại theo voiceRank. Giọng qua mạng chỉ được dùng
 * khi allowNetwork bật, vì văn bản bị gửi tới dịch vụ bên ngoài.
 */
export function pickVoice<T extends VoiceInfo>(
  voices: readonly T[],
  opts: { preferredName: string | null; allowNetwork: boolean; langPrefix?: string },
): { voice: T | null; status: VoiceStatus } {
  const vi = vietnameseVoices(voices, opts.langPrefix ?? 'vi');
  if (vi.length === 0) return { voice: null, status: 'no-vietnamese-voice' };
  const usable = vi.filter((v) => v.localService || opts.allowNetwork);
  if (usable.length === 0) return { voice: null, status: 'only-network-voice' };
  const preferred = opts.preferredName ? usable.find((v) => v.name === opts.preferredName) : undefined;
  if (preferred) return { voice: preferred, status: 'ok' };
  const best = usable.reduce((a, b) => (voiceRank(b) < voiceRank(a) ? b : a));
  return { voice: best, status: 'ok' };
}

/**
 * Chọn giọng tiếng Anh cho các từ tiếng Anh xen trong câu. Ưu tiên giọng chạy trên máy, en-US trước.
 * Giọng qua mạng chỉ dùng khi người dùng cho phép (giống giọng tiếng Việt).
 */
export function pickEnglishVoice<T extends VoiceInfo>(voices: readonly T[], opts: { allowNetwork: boolean }): T | null {
  const en = voices.filter((v) => isVietnamese(v, 'en'));
  const usable = en.filter((v) => v.localService || opts.allowNetwork);
  if (usable.length === 0) return null;
  const rank = (v: T) => (v.lang.toLowerCase().replace('_', '-') === 'en-us' ? 0 : 1) + (v.localService ? 0 : 2);
  return [...usable].sort((a, b) => rank(a) - rank(b))[0]!;
}
