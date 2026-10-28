export const SETTINGS_KEY = 'vyron.settings';

/**
 * Chỉ giữ những gì người dùng thật sự cần chọn. Tốc độ đọc, chế độ đồng bộ, bỏ nhãn âm thanh
 * đều do VYRON tự quyết định (xem speech/speech-driver.ts).
 */
export interface UserSettings {
  settingsVersion: number;
  speechEnabled: boolean;
  /** Âm lượng video khi giọng dịch đang đọc, theo tỷ lệ âm lượng gốc (0 - 1). */
  duckLevel: number;
  /** Giọng chọn tay. null = tự chọn giọng tiếng Việt tốt nhất chạy trên máy. */
  voiceName: string | null;
  /** Giọng qua mạng (như Hoài My, Nam Minh trên Edge) gửi văn bản tới dịch vụ giọng nói -> mặc định bật, tắt được trong popup. */
  allowNetworkVoice: boolean;
  /**
   * Cách đọc từ tiếng Anh xen trong câu (hai chế độ, luôn có đúng một chế độ được bật):
   * true = đổi sang giọng tiếng Anh (nếu máy có); false = giọng Việt đọc phiên âm sẵn kiểu Việt (liền mạch, không đổi giọng).
   */
  readEnglish: boolean;
  /** Câu có tối đa chừng này từ thì bỏ dấu câu để đọc lướt liền mạch (0 = luôn giữ dấu câu). */
  shortSentenceWords: number;
  /** Tốc độ đọc tối đa khi phải bắt kịp video (1.1 - 1.7). Thấp hơn thì nghe tự nhiên hơn nhưng dễ bỏ sót câu. */
  maxRate: number;
  /** Hiện bảng chẩn đoán trên trang video (dành cho lúc kiểm tra lỗi). */
  debugHud: boolean;
}

/** Bản cài đặt hiện tại. Bản < 2 chưa có giọng qua mạng bật sẵn nên được chuyển sang bật một lần. */
export const SETTINGS_VERSION = 2;
export const SHORT_WORDS_MAX = 12;
export const MAX_RATE_MIN = 1.1;
export const MAX_RATE_MAX = 1.7;

export const DEFAULT_SETTINGS: UserSettings = {
  settingsVersion: SETTINGS_VERSION,
  speechEnabled: true,
  duckLevel: 0.15,
  voiceName: null,
  allowNetworkVoice: true,
  readEnglish: false,
  shortSentenceWords: 5,
  maxRate: 1.7,
  debugHud: false,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function sanitizeSettings(raw: unknown): UserSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    settingsVersion: SETTINGS_VERSION,
    speechEnabled: typeof r.speechEnabled === 'boolean' ? r.speechEnabled : DEFAULT_SETTINGS.speechEnabled,
    duckLevel: clamp(num(r.duckLevel, DEFAULT_SETTINGS.duckLevel), 0, 1),
    voiceName: typeof r.voiceName === 'string' && r.voiceName ? r.voiceName : null,
    allowNetworkVoice: r.settingsVersion === SETTINGS_VERSION && typeof r.allowNetworkVoice === 'boolean' ? r.allowNetworkVoice : true,
    readEnglish: typeof r.readEnglish === 'boolean' ? r.readEnglish : DEFAULT_SETTINGS.readEnglish,
    shortSentenceWords: Math.round(clamp(num(r.shortSentenceWords, DEFAULT_SETTINGS.shortSentenceWords), 0, SHORT_WORDS_MAX)),
    maxRate: Math.round(clamp(num(r.maxRate, DEFAULT_SETTINGS.maxRate), MAX_RATE_MIN, MAX_RATE_MAX) * 10) / 10,
    debugHud: r.debugHud === true,
  };
}

export async function loadSettings(): Promise<UserSettings> {
  const o = (await chrome.storage.local.get(SETTINGS_KEY)) as Record<string, unknown>;
  return sanitizeSettings(o[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<UserSettings>): Promise<void> {
  const cur = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: sanitizeSettings({ ...cur, ...patch }) });
}
