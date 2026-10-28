import type { PopupRequest } from '../shared/protocol.ts';
import type { StateSnapshot } from '../shared/types.ts';
import { DEFAULT_SETTINGS, SHORT_WORDS_MAX, loadSettings, saveSettings } from '../shared/user-settings.ts';
import type { UserSettings } from '../shared/user-settings.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const spEnabled = $<HTMLInputElement>('spEnabled');
const statusEl = $('status');
const statusTitle = $('statusTitle');
const statusSub = $('statusSub');
const retryBtn = $<HTMLButtonElement>('retry');
const spDuck = $<HTMLInputElement>('spDuck');
const spDuckVal = $('spDuckVal');
const spShort = $<HTMLInputElement>('spShort');
const spShortVal = $('spShortVal');
const spVoice = $<HTMLSelectElement>('spVoice');
const spNetwork = $<HTMLInputElement>('spNetwork');
const debugHud = $<HTMLInputElement>('debugHud');
const englishVoice = $<HTMLInputElement>('englishVoice');
const englishViet = $<HTMLInputElement>('englishViet');
const spRate = $<HTMLInputElement>('spRate');
const spRateVal = $('spRateVal');
const englishInfo = $('englishInfo');
const clearCacheBtn = $<HTMLButtonElement>('clearCache');
const cacheInfo = $('cacheInfo');

type Tone = 'idle' | 'ok' | 'live' | 'busy' | 'warn' | 'error';
interface View {
  tone: Tone;
  title: string;
  sub?: string;
  retry?: PopupRequest['type'];
}

let tabId: number | null = null;
let settings: UserSettings = DEFAULT_SETTINGS;
let voiceSignature = '';
let retryType: PopupRequest['type'] | null = null;

async function send<T>(msg: PopupRequest): Promise<T | null> {
  if (tabId === null) return null;
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    return null; // tab không có content script (không phải YouTube, hoặc chưa tải lại sau khi nạp extension)
  }
}

/** Gom mọi tình huống thành MỘT dòng trạng thái dễ hiểu cho người dùng. */
function describe(s: StateSnapshot | null, st: UserSettings): View {
  if (!s) {
    return {
      tone: 'warn',
      title: 'Chưa kết nối với trang',
      sub: 'Mở một video trên youtube.com, rồi tải lại trang (F5) nếu vừa cập nhật extension.',
    };
  }
  switch (s.status) {
    case 'not-video-page':
      return { tone: 'idle', title: 'Chưa ở trang video', sub: 'Mở một video YouTube để bắt đầu.' };
    case 'loading':
      return { tone: 'busy', title: 'Đang lấy phụ đề…' };
    case 'error':
      return {
        tone: 'error',
        title: s.error?.code === 'NO_CAPTION_TRACKS' ? 'Video này không có phụ đề' : 'Không lấy được phụ đề',
        sub: s.error?.hint ?? s.error?.message,
        retry: 'RELOAD',
      };
    case 'ready':
      break;
  }

  const t = s.translation;
  switch (t.phase) {
    case 'needs-download':
      return {
        tone: 'warn',
        title: 'Cần tải gói dịch tiếng Việt',
        sub: 'Bấm nút "Tải về" trên khung video (chỉ một lần). Chrome chỉ cho tải khi bạn bấm trực tiếp trên trang.',
      };
    case 'downloading':
      return { tone: 'busy', title: `Đang tải gói tiếng Việt… ${(t.progress * 100).toFixed(0)}%` };
    case 'idle':
    case 'checking':
    case 'preparing':
      return { tone: 'busy', title: 'Đang chuẩn bị bộ dịch…' };
    case 'unsupported':
      return { tone: 'error', title: 'Chrome này chưa hỗ trợ dịch', sub: t.error?.message };
    case 'error':
      return { tone: 'error', title: 'Dịch bị lỗi', sub: t.error?.message, retry: 'RETRY_TRANSLATION' };
    case 'ready':
    case 'not-needed':
      break;
  }

  if (!st.speechEnabled) return { tone: 'idle', title: 'Giọng đọc đang tắt', sub: 'Bật công tắc phía trên để nghe bản dịch.' };

  const sp = s.speech;
  switch (sp.status) {
    case 'unsupported':
      return { tone: 'error', title: 'Trình duyệt không có giọng đọc' };
    case 'loading':
      return { tone: 'busy', title: 'Đang tải giọng đọc…' };
    case 'no-vietnamese-voice':
      return {
        tone: 'warn',
        title: 'Máy chưa có giọng tiếng Việt',
        sub: 'Thêm gói ngôn ngữ Tiếng Việt kèm giọng đọc trong cài đặt hệ điều hành rồi khởi động lại Chrome.',
      };
    case 'only-network-voice':
      return {
        tone: 'warn',
        title: 'Chỉ có giọng qua mạng',
        sub: 'Mở "Nâng cao" và tick "Cho phép giọng qua mạng" nếu bạn đồng ý gửi văn bản dịch tới dịch vụ giọng nói của trình duyệt.',
      };
    case 'ok':
      break;
  }
  if (sp.needsActivation) return { tone: 'warn', title: 'Bấm vào video một lần', sub: 'Chrome chặn đọc cho tới khi bạn có thao tác trên trang.' };
  const voice = sp.selectedVoice?.name ?? '';
  const rate = `${sp.sync.rate.toFixed(2).replace(/0$/, '')}x`;
  if (sp.sync.mode === 'catchup') return { tone: 'busy', title: 'Đang tăng tốc để bắt kịp video', sub: `${voice} · ${rate}` };
  if (sp.speaking) return { tone: 'live', title: 'Đang đọc bản dịch', sub: `${voice} · ${rate}` };
  return { tone: 'ok', title: 'Sẵn sàng', sub: `${voice} · tự điều chỉnh tốc độ theo video` };
}

function renderStatus(v: View): void {
  statusEl.dataset.tone = v.tone;
  statusTitle.textContent = v.title;
  statusSub.textContent = v.sub ?? '';
  retryType = v.retry ?? null;
  retryBtn.hidden = !retryType;
}

function renderVoices(s: StateSnapshot | null): void {
  const voices = s?.speech.voices ?? [];
  const sig = voices.map((v) => `${v.name}|${v.localService}`).join(',');
  if (sig !== voiceSignature) {
    voiceSignature = sig;
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Tự chọn (ưu tiên Hoài My, Nam Minh)';
    spVoice.replaceChildren(
      auto,
      ...voices.map((v) => {
        const o = document.createElement('option');
        o.value = v.name;
        o.textContent = `${v.name} · ${v.localService ? 'trên máy' : 'qua mạng'}`;
        return o;
      }),
    );
  }
  if (s) {
    englishInfo.textContent = s.speech.englishVoice
      ? `Giọng: ${s.speech.englishVoice.name}. Đọc đúng tên riêng, thương hiệu, thuật ngữ; mỗi lần đổi giọng có khoảng nghỉ ngắn.`
      : 'Máy chưa có giọng tiếng Anh nên tạm đọc bằng giọng Việt. Thêm gói ngôn ngữ English trong cài đặt hệ điều hành.';
  }
  spVoice.disabled = voices.length === 0;
  if (document.activeElement !== spVoice) {
    spVoice.value = voices.some((v) => v.name === settings.voiceName) ? (settings.voiceName ?? '') : '';
  }
}

function renderSettingsControls(): void {
  spEnabled.checked = settings.speechEnabled;
  spNetwork.checked = settings.allowNetworkVoice;
  debugHud.checked = settings.debugHud;
  englishVoice.checked = settings.readEnglish;
  englishViet.checked = !settings.readEnglish;
  if (document.activeElement !== spRate) spRate.value = String(Math.round(settings.maxRate * 10));
  paintRate(Math.round(settings.maxRate * 10));
  const pct = Math.round(settings.duckLevel * 100);
  if (document.activeElement !== spDuck) spDuck.value = String(pct);
  paintSlider(pct);
  if (document.activeElement !== spShort) spShort.value = String(settings.shortSentenceWords);
  paintShort(settings.shortSentenceWords);
}

function paintRate(tenths: number): void {
  spRateVal.textContent = `${(tenths / 10).toFixed(1)}x`;
  spRate.style.setProperty('--fill', `${((tenths - 11) / 6) * 100}%`);
}

function paintShort(words: number): void {
  spShortVal.textContent = words === 0 ? 'Luôn giữ dấu' : `≤ ${words} từ`;
  spShort.style.setProperty('--fill', `${(words / SHORT_WORDS_MAX) * 100}%`);
}

function paintSlider(pct: number): void {
  spDuckVal.textContent = `${pct}%`;
  spDuck.style.setProperty('--fill', `${pct}%`);
}

async function refreshCacheInfo(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'CACHE_STATS' })) as
      | { ok: boolean; data?: { entries: number } }
      | undefined;
    cacheInfo.textContent = res?.ok && res.data ? `${res.data.entries} mục` : '';
  } catch {
    cacheInfo.textContent = '';
  }
}

async function refresh(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  const state = await send<StateSnapshot>({ type: 'GET_STATE' });
  renderStatus(describe(state, settings));
  renderVoices(state);
}

// ---------- Cài đặt (lưu ở chrome.storage.local; content script tự nhận thay đổi) ----------
const save = (patch: Partial<UserSettings>) => {
  settings = { ...settings, ...patch };
  void saveSettings(patch);
  void refresh();
};
spEnabled.addEventListener('change', () => save({ speechEnabled: spEnabled.checked }));
spNetwork.addEventListener('change', () => save({ allowNetworkVoice: spNetwork.checked }));
englishVoice.addEventListener('change', () => save({ readEnglish: englishVoice.checked }));
englishViet.addEventListener('change', () => save({ readEnglish: !englishViet.checked }));
spRate.addEventListener('input', () => paintRate(Number(spRate.value)));
spRate.addEventListener('change', () => save({ maxRate: Number(spRate.value) / 10 }));
debugHud.addEventListener('change', () => save({ debugHud: debugHud.checked }));
spVoice.addEventListener('change', () => save({ voiceName: spVoice.value || null }));
spShort.addEventListener('input', () => paintShort(Number(spShort.value)));
spShort.addEventListener('change', () => save({ shortSentenceWords: Number(spShort.value) }));
spDuck.addEventListener('input', () => paintSlider(Number(spDuck.value)));
spDuck.addEventListener('change', () => save({ duckLevel: Number(spDuck.value) / 100 }));
retryBtn.addEventListener('click', () => {
  if (retryType) void send({ type: retryType });
});
clearCacheBtn.addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ bản dịch đã lưu? Các đoạn sẽ được dịch lại khi cần.')) return;
  try {
    await chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' });
  } catch {
    /* số mục hiển thị bên cạnh sẽ cho thấy kết quả thật */
  }
  await refreshCacheInfo();
});

void loadSettings().then((s) => {
  settings = s;
  renderSettingsControls();
  void refresh();
});
void refreshCacheInfo();
window.setInterval(() => void refresh(), 600);
