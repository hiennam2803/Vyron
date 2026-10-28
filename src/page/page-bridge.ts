/**
 * Chạy trong MAIN world của trang YouTube (khai báo "world": "MAIN" trong manifest).
 * Lý do: content script thường không đọc được đối tượng JS của trang (player, ytInitialPlayerResponse).
 * Chỉ làm 2 việc: (1) liệt kê caption tracks của video hiện tại, (2) tải nội dung một track.
 * Không parse, không xử lý nghiệp vụ - việc đó nằm ở content script.
 */
import { BRIDGE_REQ, BRIDGE_RES } from '../shared/protocol.ts';
import type {
  BridgeProgress,
  BridgeRequest,
  BridgeResponse,
  FetchTrackResult,
  GetTracksResult,
  TrAvailability,
  TrAvailabilityResult,
  TrBatchResult,
} from '../shared/protocol.ts';
import type { CaptionKind, CaptionTrack, ErrorCode } from '../shared/types.ts';

class BridgeError extends Error {
  code: ErrorCode;
  hint: string | undefined;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const w = window as unknown as { __vyronBridge?: boolean; ytInitialPlayerResponse?: unknown };

// ---------- Player response ----------
interface PlayerElement extends HTMLElement {
  getPlayerResponse?: () => unknown;
  isSubtitlesOn?: () => boolean;
  toggleSubtitlesOn?: () => void;
  toggleSubtitles?: () => void;
  loadModule?: (module: string) => void;
  getOption?: (module: string, option: string) => unknown;
  setOption?: (module: string, option: string, value: unknown) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function getPlayerResponse(): Json {
  const el = document.getElementById('movie_player') as PlayerElement | null;
  try {
    const r = el?.getPlayerResponse?.();
    if (r) return r;
  } catch {
    /* player chưa sẵn sàng */
  }
  return w.ytInitialPlayerResponse ?? null;
}

function getTracks(videoId: string): GetTracksResult {
  const pr = getPlayerResponse();
  if (!pr) {
    throw new BridgeError('NO_PLAYER', 'Chưa lấy được dữ liệu player của YouTube.');
  }
  const playerVideoId: unknown = pr?.videoDetails?.videoId;
  if (playerVideoId !== videoId) {
    throw new BridgeError(
      'VIDEO_MISMATCH',
      `Dữ liệu player thuộc video khác (${String(playerVideoId)} ≠ ${videoId}).`,
    );
  }
  const list: Json = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list) || list.length === 0) {
    throw new BridgeError(
      'NO_CAPTION_TRACKS',
      'Video này không có track phụ đề nào trong dữ liệu player.',
      'Thử video khác có biểu tượng CC. Chưa có phương án thay thế cho video không có phụ đề ở Phase 1a.',
    );
  }
  const tracks: CaptionTrack[] = list.map((t: Json): CaptionTrack => {
    const name: string =
      t?.name?.simpleText ??
      (Array.isArray(t?.name?.runs) ? t.name.runs.map((r: Json) => r?.text ?? '').join('') : '') ??
      '';
    return {
      languageCode: String(t?.languageCode ?? ''),
      name: name || String(t?.languageCode ?? '?'),
      kind: t?.kind === 'asr' ? 'asr' : 'manual',
      vssId: String(t?.vssId ?? ''),
      baseUrl: String(t?.baseUrl ?? ''),
      isTranslatable: Boolean(t?.isTranslatable),
    };
  });
  return { tracks };
}

// ---------- Ghi nhận URL timedtext do chính player YouTube gọi (phương án dự phòng) ----------
// Khi người dùng bật CC, player gọi /api/timedtext kèm tham số `pot`. Nếu baseUrl "trần" bị trả về rỗng,
// ta thử lại bằng URL mà player đã dùng thành công.
const capturedUrls = new Map<string, string>();
const ownUrls = new Set<string>();

const captureKey = (videoId: string, lang: string, kind: CaptionKind) => `${videoId}|${lang}|${kind}`;

function recordResource(rawUrl: string): void {
  if (!rawUrl.includes('/api/timedtext') || ownUrls.has(rawUrl)) return;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return;
  }
  if (!u.searchParams.has('pot')) return;
  const v = u.searchParams.get('v');
  if (!v) return;
  const kind: CaptionKind = u.searchParams.get('kind') === 'asr' ? 'asr' : 'manual';
  capturedUrls.set(captureKey(v, u.searchParams.get('lang') ?? '', kind), rawUrl);
}

function observeTimedtext(): void {
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) recordResource(e.name);
    });
    obs.observe({ type: 'resource', buffered: true });
  } catch {
    /* PerformanceObserver không hỗ trợ -> bỏ qua phương án dự phòng */
  }
}

// ---------- Tự bật CC tạm thời để player gọi timedtext hợp lệ ----------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForCaptured(key: string, timeoutMs: number): Promise<string | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const u = capturedUrls.get(key);
    if (u) return u;
    await sleep(150);
  }
  return capturedUrls.get(key);
}

/**
 * Bật CC (và chọn đúng track nếu cần) để player tự gọi /api/timedtext, bắt lấy URL rồi trả player về như cũ.
 * Dựa trên API không chính thức của player YouTube nên có thể ngừng hoạt động; mọi bước đều kiểm tra tồn tại.
 * Luôn trả về `diag` mô tả từng bước để chẩn đoán khi thất bại.
 */
async function captureViaPlayer(
  videoId: string,
  track: { languageCode: string; kind: CaptionKind },
): Promise<{ url: string | undefined; diag: string }> {
  const steps: string[] = [];
  const yn = (b: boolean) => (b ? 'có' : 'không');
  const player = document.getElementById('movie_player') as PlayerElement | null;
  steps.push(`player=${yn(!!player)}`);
  steps.push(`quảng cáo=${yn(document.querySelector('.html5-video-player.ad-showing') !== null)}`);
  if (!player) return { url: undefined, diag: steps.join(', ') };
  steps.push(
    `toggleSubtitlesOn=${typeof player.toggleSubtitlesOn}`,
    `isSubtitlesOn=${typeof player.isSubtitlesOn}`,
    `loadModule=${typeof player.loadModule}`,
    `setOption=${typeof player.setOption}`,
  );

  const key = captureKey(videoId, track.languageCode, track.kind);
  const wasOn = player.isSubtitlesOn?.() ?? false;
  steps.push(`CC ban đầu=${wasOn ? 'bật' : 'tắt'}`);
  let previousTrack: unknown;
  try {
    previousTrack = player.getOption?.('captions', 'track');
  } catch {
    /* bỏ qua */
  }
  try {
    try {
      player.loadModule?.('captions');
    } catch {
      steps.push('loadModule lỗi');
    }
    if (!wasOn) player.toggleSubtitlesOn?.();
    let url = await waitForCaptured(key, 3000);
    steps.push(`sau bật CC: ${url ? 'bắt được URL' : 'không có URL'}`);
    if (!url) {
      player.setOption?.('captions', 'track', {
        languageCode: track.languageCode,
        ...(track.kind === 'asr' ? { kind: 'asr' } : {}),
      });
      url = await waitForCaptured(key, 3000);
      steps.push(`sau chọn track: ${url ? 'bắt được URL' : 'không có URL'}`);
    }
    return { url, diag: steps.join(', ') };
  } finally {
    try {
      if (previousTrack && typeof previousTrack === 'object' && Object.keys(previousTrack).length > 0) {
        player.setOption?.('captions', 'track', previousTrack);
      }
      if (!wasOn && player.isSubtitlesOn?.()) player.toggleSubtitles?.();
    } catch {
      /* bỏ qua */
    }
  }
}

// ---------- Tải một track ----------
type TryResult = { ok: true; body: string } | { ok: false; reason: string; empty: boolean };

async function tryFetch(url: string): Promise<TryResult> {
  ownUrls.add(url);
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch (e) {
    return { ok: false, reason: `lỗi mạng: ${String(e)}`, empty: false };
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, empty: false };
  if (body.trim().length === 0) return { ok: false, reason: 'HTTP 200 nhưng nội dung rỗng', empty: true };
  if (!body.trimStart().startsWith('{')) return { ok: false, reason: 'nội dung không phải JSON', empty: false };
  return { ok: true, body };
}

function withJson3(rawUrl: string): string {
  const u = new URL(rawUrl, location.origin);
  u.searchParams.set('fmt', 'json3');
  return u.toString();
}

async function fetchTrack(
  videoId: string,
  track: { baseUrl: string; languageCode: string; kind: CaptionKind },
): Promise<FetchTrackResult> {
  if (!track.baseUrl) throw new BridgeError('FETCH_FAILED', 'Track không có baseUrl.');

  const first = await tryFetch(withJson3(track.baseUrl));
  if (first.ok) return { method: 'baseUrl', body: first.body, firstAttemptFailure: null };

  let captured = capturedUrls.get(captureKey(videoId, track.languageCode, track.kind));
  let autoEnabled = false;
  let diag = '';
  if (!captured) {
    const r = await captureViaPlayer(videoId, track);
    captured = r.url;
    diag = r.diag;
    autoEnabled = r.url !== undefined;
  }
  let second: TryResult | null = null;
  if (captured) {
    second = await tryFetch(withJson3(captured));
    if (second.ok) {
      return {
        method: 'player-captured',
        body: second.body,
        firstAttemptFailure: autoEnabled ? `${first.reason} (VYRON đã tự bật CC tạm thời)` : first.reason,
      };
    }
  }

  const detail = second ? `${first.reason}; thử lại bằng URL của player: ${second.reason}` : first.reason;
  throw new BridgeError(
    first.empty ? 'EMPTY_RESPONSE' : 'FETCH_FAILED',
    `Không tải được nội dung phụ đề (${detail})${diag ? ` [tự bật CC: ${diag}]` : ''}.`,
    captured
      ? 'Cả URL gốc và URL do player dùng đều thất bại. Báo lại thông tin này để chọn phương án thay thế.'
      : 'YouTube có thể yêu cầu token (pot) cho request này. VYRON đã thử tự bật CC nhưng không bắt được URL của player. Bật CC trên player (đúng ngôn ngữ cần lấy) một lần rồi bấm "Tải lại" trong popup.',
  );
}

// ---------- Chrome Translator API ----------
// Chạy ở MAIN world vì API gắn với tài liệu trang (và cần user activation của trang để tải gói ngôn ngữ).
interface TranslatorInstance {
  translate(text: string): Promise<string>;
}
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<TranslatorInstance>;
}
const translators = new Map<string, TranslatorInstance>();
const pairKey = (s: string, t: string) => `${s}>${t}`;
const translatorApi = () => (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;

function normalizeAvailability(v: string): TrAvailability {
  switch (v) {
    case 'available':
    case 'readily': // tên cũ của API
      return 'available';
    case 'downloadable':
    case 'after-download':
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    default:
      return 'unavailable';
  }
}

function translatorError(e: unknown): BridgeError {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'NotAllowedError') {
    return new BridgeError(
      'TRANSLATOR_NEEDS_ACTIVATION',
      'Chrome yêu cầu bạn bấm trực tiếp trên trang để tải gói ngôn ngữ.',
      'Bấm nút "Tải gói ngôn ngữ" trong bảng VYRON ở góc dưới trái trang YouTube.',
    );
  }
  if (name === 'NotSupportedError') {
    return new BridgeError('TRANSLATOR_UNAVAILABLE', `Cặp ngôn ngữ không được hỗ trợ (${msg}).`);
  }
  return new BridgeError(
    'TRANSLATOR_FAILED',
    `Translator API lỗi (${name || 'Error'}: ${msg}).`,
    'Nếu đang tải gói ngôn ngữ, kiểm tra kết nối mạng và dung lượng ổ đĩa rồi thử lại.',
  );
}

async function trAvailability(source: string, target: string): Promise<TrAvailabilityResult> {
  const api = translatorApi();
  if (!api) return { availability: 'unsupported-api' };
  try {
    return { availability: normalizeAvailability(await api.availability({ sourceLanguage: source, targetLanguage: target })) };
  } catch (e) {
    throw translatorError(e);
  }
}

async function trPrepare(id: number, source: string, target: string): Promise<Record<string, never>> {
  if (translators.has(pairKey(source, target))) return {};
  const api = translatorApi();
  if (!api) throw new BridgeError('TRANSLATOR_UNSUPPORTED', 'Chrome này không có Translator API.');
  try {
    const instance = await api.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor(m) {
        m.addEventListener('downloadprogress', (ev) => {
          const { loaded, total } = ev as unknown as { loaded: number; total?: number };
          const fraction = total && total > 0 ? loaded / total : loaded; // Chrome báo 0..1; một số bản cũ báo byte
          const msg: BridgeProgress = { source: BRIDGE_RES, id, progress: Math.max(0, Math.min(1, fraction)) };
          window.postMessage(msg, location.origin);
        });
      },
    });
    translators.set(pairKey(source, target), instance);
    return {};
  } catch (e) {
    throw translatorError(e);
  }
}

async function trBatch(source: string, target: string, texts: string[]): Promise<TrBatchResult> {
  const tr = translators.get(pairKey(source, target));
  if (!tr) throw new BridgeError('TRANSLATOR_FAILED', 'Bộ dịch chưa được khởi tạo.');
  const items: TrBatchResult['items'] = [];
  for (const text of texts.slice(0, 50)) {
    try {
      items.push({ ok: true, text: await tr.translate(String(text)) });
    } catch (e) {
      items.push({ ok: false, message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
    }
  }
  return { items };
}

// ---------- Giao tiếp với content script ----------
function reply(msg: BridgeResponse): void {
  window.postMessage(msg, location.origin);
}

async function handle(req: BridgeRequest): Promise<void> {
  try {
    if (req.type === 'GET_TRACKS') {
      reply({ source: BRIDGE_RES, id: req.id, ok: true, data: getTracks(req.videoId) });
    } else if (req.type === 'FETCH_TRACK') {
      const data = await fetchTrack(req.videoId, req.track);
      reply({ source: BRIDGE_RES, id: req.id, ok: true, data });
    } else if (req.type === 'TR_AVAILABILITY') {
      reply({ source: BRIDGE_RES, id: req.id, ok: true, data: await trAvailability(req.srcLang, req.tgtLang) });
    } else if (req.type === 'TR_PREPARE') {
      reply({ source: BRIDGE_RES, id: req.id, ok: true, data: await trPrepare(req.id, req.srcLang, req.tgtLang) });
    } else if (req.type === 'TR_TRANSLATE_BATCH') {
      reply({ source: BRIDGE_RES, id: req.id, ok: true, data: await trBatch(req.srcLang, req.tgtLang, req.texts) });
    }
  } catch (e) {
    const err =
      e instanceof BridgeError
        ? { code: e.code, message: e.message, hint: e.hint }
        : { code: 'UNKNOWN' as const, message: e instanceof Error ? e.message : String(e) };
    reply({ source: BRIDGE_RES, id: req.id, ok: false, error: err });
  }
}

if (!w.__vyronBridge) {
  w.__vyronBridge = true;
  observeTimedtext();
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const d = ev.data as Partial<BridgeRequest> | null;
    if (!d || d.source !== BRIDGE_REQ || typeof d.id !== 'number') return;
    void handle(d as BridgeRequest);
  });
}
