/**
 * Phiên âm sẵn kiểu Việt cho từ tiếng Anh thông dụng, để giọng Việt đọc liền một mạch mà không phải đổi sang giọng Anh
 * (mỗi lần đổi giọng Chrome có một khoảng hở). Đổi lại, cách đọc chỉ gần đúng và chỉ phủ những từ có trong danh sách.
 * Từ không có trong danh sách vẫn đi theo đường cũ (giọng Anh nếu máy có).
 *
 * Mỗi âm tiết cách nhau bằng dấu cách (không dùng gạch nối) để giọng Việt đọc từng âm tiết rõ ràng.
 * Muốn thêm từ: thêm một dòng vào WORDS (không phân biệt hoa thường) hoặc ACRONYMS (phải viết HOA đúng như vậy).
 * Chỉ thêm những từ KHÔNG trùng với âm tiết tiếng Việt không dấu (như "an", "tin", "ban").
 */
const WORDS: Record<string, string> = {
  // Thương hiệu, nền tảng
  youtube: 'diu túp', youtuber: 'diu túp bơ', google: 'gu gồ', facebook: 'phây búc', instagram: 'in sờ ta gram',
  tiktok: 'tích tóc', twitter: 'tguýt tơ', netflix: 'nét phờ lích', amazon: 'a ma dôn', apple: 'áp pồ',
  iphone: 'ai phôn', ipad: 'ai pét', android: 'an đờ roi', windows: 'guyn đâu', microsoft: 'mai cờ rô sóp',
  samsung: 'sam sung', tesla: 'téc la', zoom: 'dum', whatsapp: 'guót áp', telegram: 'te lê gram',
  messenger: 'mét sen giơ', linkedin: 'lính kờ đin', reddit: 'rét đít', twitch: 'tuýt', spotify: 'sờ pót ti phai',
  uber: 'u bơ', grab: 'grép', nvidia: 'en vi đi a', intel: 'in teo', nike: 'nai ki', adidas: 'a đi đát',
  chatgpt: 'chát gi pi ti', openai: 'âu pần ây ai', bitcoin: 'bít coi', blockchain: 'bờ lóc chên',
  // Công nghệ, mạng xã hội
  email: 'i meo', website: 'guép sai', link: 'lính', chat: 'chát', like: 'lai', share: 'se', subscribe: 'sấp cờ rai',
  channel: 'chan nồ', comment: 'com men', livestream: 'lai strim', podcast: 'póc cát', update: 'úp đết',
  download: 'đao lốt', upload: 'úp lốt', smartphone: 'sờ mát phôn', software: 'sóp guê', hardware: 'hát guê',
  bluetooth: 'blu tút', robot: 'rô bốt', camera: 'ca me ra', logo: 'lô gô', electric: 'i léc trích',
  digital: 'đi di tồ', hacker: 'hách cơ', hack: 'hách', selfie: 'sên phi', vlog: 'vờ lóc', hashtag: 'hát tách',
  viral: 'vai rồ', trend: 'trên', trailer: 'trây lơ', startup: 'sờ tát âp', marketing: 'ma két tinh',
  // Công việc, đời sống
  ok: 'ô kê', okay: 'ô kê', hello: 'hê lô', bye: 'bai', yes: 'ét', sorry: 'so ri', boss: 'bót', fan: 'phen',
  fans: 'phen', feedback: 'phít bách', team: 'tim', leader: 'li đơ', manager: 'ma ne giơ', meeting: 'mi tinh',
  deadline: 'đét lai', project: 'pờ rô gék', design: 'đi zai', designer: 'đi zai nơ', brand: 'bran',
  content: 'con ten', creator: 'cờ ri ây tơ', idol: 'ai đồ', concert: 'con sớt', fashion: 'phé sần',
  style: 'sờ tai', sale: 'sêu', free: 'phri', premium: 'prê mi âm', vip: 'vít', pro: 'prô', max: 'mác',
  plus: 'plát', mini: 'mi ni',
};

/** Từ viết tắt: phải viết HOA đúng như vậy mới được thay (để "ai" tiếng Việt, nghĩa là "người nào", không bị đổi). */
const ACRONYMS: Record<string, string> = {
  AI: 'ây ai', CEO: 'xi i ô', USB: 'diu ét bi', GPS: 'gi pi ét', TV: 'ti vi', PC: 'pi xi', CPU: 'xi pi diu',
  GPU: 'gi pi diu', GPT: 'gi pi ti', VR: 'vi a', AR: 'ây a', SUV: 'ét diu vi', DNA: 'đi en ây', FBI: 'ép bi ai',
  CIA: 'xi ai ây', USA: 'diu ét ây', UK: 'diu kây', UFO: 'diu ép ô', PDF: 'pi đi ép', SMS: 'ét em ét',
  HD: 'ếch đi', ID: 'ai đi', IT: 'ai ti', NASA: 'na sa', NATO: 'na tô', COVID: 'cô vít',
};

const BOUNDARY_BEFORE = "(?<![\\p{L}\\p{N}'’])";
const BOUNDARY_AFTER = "(?![\\p{L}\\p{N}'’])";
const alternation = (keys: string[]) => [...keys].sort((a, b) => b.length - a.length).join('|');
const WORD_RE = new RegExp(`${BOUNDARY_BEFORE}(${alternation(Object.keys(WORDS))})${BOUNDARY_AFTER}`, 'giu');
const ACRONYM_RE = new RegExp(`${BOUNDARY_BEFORE}(${alternation(Object.keys(ACRONYMS))})${BOUNDARY_AFTER}`, 'gu');

/** Thay từ tiếng Anh thông dụng bằng cách phiên âm kiểu Việt. Từ không có trong danh sách giữ nguyên. */
export function respellEnglish(text: string): string {
  return text.replace(ACRONYM_RE, (m) => ACRONYMS[m] ?? m).replace(WORD_RE, (m) => WORDS[m.toLowerCase()] ?? m);
}
