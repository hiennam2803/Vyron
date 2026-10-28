import type {
  CaptionTrack,
  ErrorCode,
  PlaybackSnapshot,
  SpeechSnapshot,
  StateSnapshot,
  Status,
  TranslationSnapshot,
  TranscriptSegment,
  TranscriptStats,
  VyronError,
} from '../shared/types.ts';
import type { FetchTrackResult, GetTracksResult, PopupRequest } from '../shared/protocol.ts';
import { getVideoIdFromUrl } from '../shared/youtube-url.ts';
import { NAVIGATION_EVENTS, findVideoElement, isAdShowing } from './youtube-adapter.ts';
import { PlaybackMonitor } from './playback-monitor.ts';
import type { MonitorEventName } from './playback-monitor.ts';
import { bridgeCall } from './bridge-client.ts';
import { findAnchorIndex, findSegmentIndex, parseJson3, pickDefaultTrackIndex } from './transcript-manager.ts';
import { mergeIntoSentences } from './sentence-merger.ts';
import { TranslationEngine } from '../translation/translation-engine.ts';
import { chromeTranslatorBackend } from './translator-backend.ts';
import { extensionCache } from './cache-client.ts';
import { BATCH_SIZE, LOOKAHEAD_SEGMENTS, TARGET_LANGUAGE, TRANSLATION_MODEL_ID } from '../shared/settings.ts';
import { DebugHud } from './debug-hud.ts';
import { StatusPill } from './status-pill.ts';
import { SpeechEngine } from '../speech/speech-engine.ts';
import type { SynthLike, UtteranceLike } from '../speech/speech-engine.ts';
import { VolumeDucker } from '../speech/ducking.ts';
import { SpeechDriver } from '../speech/speech-driver.ts';
import { DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, sanitizeSettings } from '../shared/user-settings.ts';
import type { UserSettings } from '../shared/user-settings.ts';

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const fmt = (t: number) => `${t.toFixed(2)}s`;

function toVyronError(e: unknown): VyronError {
  if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
    const o = e as { code: unknown; message: unknown; hint?: unknown };
    return {
      code: o.code as ErrorCode,
      message: String(o.message),
      hint: typeof o.hint === 'string' ? o.hint : undefined,
    };
  }
  return { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
}

class VyronController {
  /** Tăng mỗi khi đổi video / chọn track / tải lại. Mọi tác vụ bất đồng bộ phải so khớp trước khi ghi kết quả. */
  private generation = 0;
  private videoId: string | null = null;
  private video: HTMLVideoElement | null = null;
  private monitor: PlaybackMonitor | null = null;

  private status: Status = 'not-video-page';
  private error: VyronError | null = null;
  private tracks: CaptionTrack[] = [];
  private selectedTrackIndex = -1;
  private fetchMethod: string | null = null;
  private fetchNote: string | null = null;
  private segments: TranscriptSegment[] = [];
  private segmentsVersion = 0;
  private stats: TranscriptStats | null = null;
  private currentSegmentIndex = -1;
  private playback: PlaybackSnapshot | null = null;
  private log: string[] = [];
  private hud = new DebugHud();
  private pill = new StatusPill();
  private engine: TranslationEngine | null = null;
  private translationVersion = 0;
  private lastAnchor = -1;
  private syncTimer: number | null = null;
  private orphaned = false;

  private settings: UserSettings = DEFAULT_SETTINGS;
  private ducker: VolumeDucker | null = null;
  private speech = new SpeechEngine(
    typeof speechSynthesis !== 'undefined'
      ? {
          synth: speechSynthesis as unknown as SynthLike,
          createUtterance: (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
          setTimeout: (fn, ms) => window.setTimeout(fn, ms),
          clearTimeout: (h) => window.clearTimeout(h as number),
          now: () => performance.now(),
        }
      : null,
    () => this.onSpeechChange(),
  );
  private driver = new SpeechDriver({
    speech: this.speech,
    getDucker: () => this.ducker,
    getSegments: () => this.segments,
    getTranslation: (i) => this.engine?.getTranslation(i) ?? null,
    getSettings: () => this.settings,
  });

  start(): void {
    for (const name of NAVIGATION_EVENTS) window.addEventListener(name, () => this.sync());
    // Lưới an toàn: YouTube có thể thay <video> hoặc đổi URL mà không phát sự kiện.
    this.syncTimer = window.setInterval(() => this.sync(), 1000);
    this.speech.setListener((e) => this.driver.onEngineEvent(e));
    void this.initSpeech();
    // Trả lại âm lượng khi rời trang để YouTube không lưu mức đã bị hạ.
    window.addEventListener('pagehide', () => this.ducker?.dispose());
    chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender, sendResponse) => {
      sendResponse(this.handlePopupMessage(msg));
      return false;
    });
    this.sync();
  }

  // ---------- Đồng bộ với trang ----------
  // ---------- Giọng đọc ----------
  private async initSpeech(): Promise<void> {
    try {
      this.settings = await loadSettings();
    } catch {
      /* dùng mặc định */
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      this.settings = sanitizeSettings(changes[SETTINGS_KEY].newValue);
      this.applySettings();
    });
    this.applySettings();
    await this.speech.init();
  }

  private applySettings(): void {
    this.speech.configure({
      preferredName: this.settings.voiceName, allowNetwork: this.settings.allowNetworkVoice,
      englishEnabled: this.settings.readEnglish, respellEnabled: !this.settings.readEnglish,
    });
    this.driver.onSettingsChanged();
    this.hud.setVisible(this.settings.debugHud);
    this.renderHud();
  }

  private onSpeechChange(): void {
    this.driver.onSpeakingChanged(this.speech.speaking);
    this.renderHud();
  }

  /** Sau khi extension được tải lại/cập nhật, content script cũ mất kết nối và không dùng được chrome.* nữa. */
  private handleOrphaned(): void {
    if (this.orphaned) return;
    this.orphaned = true;
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
    this.monitor?.stop();
    this.monitor = null;
    this.engine?.dispose();
    this.engine = null;
    this.speech.cancel();
    this.ducker?.dispose(); // trả lại âm lượng gốc
    this.ducker = null;
    this.pill.show({ tone: 'warn', text: 'VYRON vừa được cập nhật. Bấm F5 để tiếp tục.', sticky: true });
    this.hud.setText('VYRON: extension vừa được tải lại hoặc cập nhật.\nBấm F5 để tải lại trang và tiếp tục.');
  }

  private sync(): void {
    if (this.orphaned) return;
    if (!chrome.runtime?.id) {
      this.handleOrphaned();
      return;
    }
    const id = getVideoIdFromUrl(location.href);
    if (id !== this.videoId) this.switchVideo(id);
    const el = id ? findVideoElement() : null;
    if (el !== this.video) this.bindVideo(el);
    this.renderHud();
  }

  private switchVideo(id: string | null): void {
    this.generation++; // hủy mọi tác vụ của video trước
    this.videoId = id;
    this.resetData();
    this.status = id ? 'loading' : 'not-video-page';
    this.note(id ? `video: ${id}` : 'không phải trang video');
    if (id) void this.loadTracks(this.generation);
  }

  private resetData(): void {
    this.error = null;
    this.tracks = [];
    this.selectedTrackIndex = -1;
    this.fetchMethod = null;
    this.fetchNote = null;
    this.setSegments([], null);
  }

  private setSegments(segments: TranscriptSegment[], stats: TranscriptStats | null): void {
    this.engine?.dispose(); // bản dịch gắn với danh sách đoạn cũ -> hủy
    this.engine = null;
    this.driver.reset();
    this.lastAnchor = -1;
    this.translationVersion++;
    this.segments = segments;
    this.stats = stats;
    this.segmentsVersion++;
    this.currentSegmentIndex = -1;
  }

  private bindVideo(el: HTMLVideoElement | null): void {
    this.monitor?.stop();
    this.monitor = null;
    this.ducker?.dispose();
    this.ducker = el ? new VolumeDucker(el) : null;
    this.driver.reset();
    this.video = el;
    this.playback = null;
    this.currentSegmentIndex = -1;
    if (!el) return;
    this.monitor = new PlaybackMonitor(
      el,
      (name, snap) => this.onPlaybackEvent(name, snap),
      (snap) => this.onTick(snap),
    );
    this.monitor.start();
    this.driver.setPlaying(!el.paused && !el.seeking);
    this.note('đã gắn vào phần tử <video>');
  }

  // ---------- Theo dõi phát ----------
  private onPlaybackEvent(name: MonitorEventName, snap: PlaybackSnapshot): void {
    const extra = name === 'ratechange' ? ` x${snap.playbackRate}` : '';
    this.note(`${fmt(snap.currentTime)} ${name}${extra}${snap.adShowing ? ' [quảng cáo]' : ''}`);
    switch (name) {
      case 'pause':
        this.driver.onPause();
        break;
      case 'playing':
        this.driver.onPlay();
        break;
      case 'seeking':
        this.driver.onSeeking();
        break;
      case 'seeked':
        this.driver.onSeeked();
        break;
      case 'emptied':
      case 'ended':
        this.driver.reset();
        break;
      default:
        break;
    }
  }

  private onTick(snap: PlaybackSnapshot): void {
    this.playback = snap;
    // Khi đang quảng cáo, currentTime thuộc quảng cáo -> không đối chiếu với phụ đề của video chính.
    if (!snap.adShowing && this.engine) {
      const anchor = findAnchorIndex(this.segments, snap.currentTime);
      if (anchor !== this.lastAnchor) {
        this.lastAnchor = anchor;
        this.engine.setPlayhead(anchor);
      }
    }
    const idx = snap.adShowing ? -1 : findSegmentIndex(this.segments, snap.currentTime);
    this.driver.onAd(snap.adShowing);
    // Luôn cập nhật mốc thời gian (kể cả khi đang tua) để lúc 'seeked' bộ đọc biết đúng vị trí mới.
    if (!snap.adShowing) this.driver.onTime(snap.currentTime, snap.playbackRate);
    if (idx !== this.currentSegmentIndex) {
      this.currentSegmentIndex = idx;
      this.note(idx >= 0 ? `đoạn #${idx} bắt đầu hiệu lực` : 'ngoài mọi đoạn phụ đề');
    }
    this.renderHud();
  }

  // ---------- Lấy phụ đề ----------
  private async loadTracks(gen: number): Promise<void> {
    const videoId = this.videoId;
    if (!videoId) return;
    this.status = 'loading';
    this.error = null;
    try {
      const { tracks } = await this.getTracksWithRetry(videoId, gen);
      if (gen !== this.generation) return;
      this.tracks = tracks;
      this.selectedTrackIndex = pickDefaultTrackIndex(tracks, 'en');
      this.note(`tìm thấy ${tracks.length} track phụ đề`);
      await this.loadSelectedTrack(gen);
    } catch (e) {
      this.fail(gen, e);
    }
  }

  /** Player có thể chưa nạp xong dữ liệu video mới ngay sau khi điều hướng SPA -> thử lại vài lần. */
  private async getTracksWithRetry(videoId: string, gen: number): Promise<GetTracksResult> {
    const maxAttempts = 12;
    for (let attempt = 1; ; attempt++) {
      try {
        return await bridgeCall<GetTracksResult>({ type: 'GET_TRACKS', videoId });
      } catch (e) {
        const err = toVyronError(e);
        const retryable = err.code === 'NO_PLAYER' || err.code === 'VIDEO_MISMATCH';
        if (!retryable || attempt >= maxAttempts) throw e;
        await sleep(500);
        if (gen !== this.generation) throw { code: 'UNKNOWN', message: 'cancelled' };
      }
    }
  }

  private async loadSelectedTrack(gen: number, attempt = 1): Promise<void> {
    const videoId = this.videoId;
    const track = this.tracks[this.selectedTrackIndex];
    if (!videoId || !track) return;
    this.status = 'loading';
    this.error = null;
    this.fetchMethod = null;
    this.fetchNote = null;
    this.setSegments([], null);
    try {
      // Trong lúc quảng cáo, player thường chưa nạp module phụ đề -> chờ quảng cáo kết thúc (tối đa 2 phút).
      if (isAdShowing()) {
        this.note('đang quảng cáo, chờ kết thúc rồi mới lấy phụ đề');
        for (let i = 0; i < 240 && isAdShowing(); i++) {
          await sleep(500);
          if (gen !== this.generation) return;
        }
      }
      const res = await bridgeCall<FetchTrackResult>({
        type: 'FETCH_TRACK',
        videoId,
        track: { baseUrl: track.baseUrl, languageCode: track.languageCode, kind: track.kind },
      }, 15000); // dài hơn mặc định vì có thể phải tự bật CC và chờ player
      if (gen !== this.generation) return; // video/track đã đổi trong lúc chờ -> bỏ kết quả cũ
      const parsed = parseJson3(res.body, track.languageCode, {
        clipOverlaps: track.kind === 'asr',
      });
      // Gộp các mảnh phụ đề bị cắt giữa câu thành câu hoàn chỉnh trước khi dịch/đọc.
      const merged = mergeIntoSentences(parsed.segments, track.languageCode);
      const segments = merged.segments;
      const stats: TranscriptStats = { ...parsed.stats, count: segments.length, sourceCount: merged.sourceCount };
      if (segments.length === 0) {
        throw {
          code: 'EMPTY_TRANSCRIPT',
          message: 'Tải được phụ đề nhưng không có đoạn nào có nội dung.',
        } satisfies VyronError;
      }
      this.fetchMethod = res.method;
      this.fetchNote = res.firstAttemptFailure;
      this.setSegments(segments, stats);
      this.status = 'ready';
      this.startTranslation(gen, track.languageCode);
      this.note(
        `đã nạp ${segments.length} câu từ ${merged.sourceCount} mảnh phụ đề (gộp ${merged.mergedGroups} câu, ${track.languageCode}/${track.kind}, qua ${res.method})`,
      );
      if (res.firstAttemptFailure) this.note(`dùng cách dự phòng vì: ${res.firstAttemptFailure}`);
      if (this.playback) this.onTick(this.playback);
    } catch (e) {
      const err = toVyronError(e);
      const retryable =
        err.code === 'EMPTY_RESPONSE' || err.code === 'FETCH_FAILED' || err.code === 'BRIDGE_TIMEOUT';
      if (retryable && attempt < 3 && gen === this.generation) {
        this.note(`lấy phụ đề lần ${attempt} thất bại (${err.code}), thử lại sau 2 giây`);
        await sleep(2000);
        if (gen !== this.generation) return;
        return this.loadSelectedTrack(gen, attempt + 1);
      }
      this.fail(gen, e);
    }
  }

  // ---------- Dịch ----------
  private startTranslation(gen: number, languageCode: string): void {
    const source = languageCode.toLowerCase().split('-')[0] || 'en';
    const engine: TranslationEngine = new TranslationEngine({
      backend: chromeTranslatorBackend,
      cache: extensionCache,
      segments: this.segments,
      sourceLanguage: source,
      targetLanguage: TARGET_LANGUAGE,
      modelId: TRANSLATION_MODEL_ID,
      lookahead: LOOKAHEAD_SEGMENTS,
      batchSize: BATCH_SIZE,
      onChange: () => {
        if (gen !== this.generation || this.engine !== engine) return;
        this.translationVersion++;
        this.driver.onTranslationsChanged();
        this.renderHud();
      },
    });
    this.engine = engine;
    this.lastAnchor = this.playback && !this.playback.adShowing ? findAnchorIndex(this.segments, this.playback.currentTime) : 0;
    engine.setPlayhead(this.lastAnchor);
    this.note(`bộ dịch ${source}→${TARGET_LANGUAGE}: kiểm tra Translator API`);
    void engine.init().then(() => {
      if (this.engine === engine) this.note(`bộ dịch: ${engine.snapshot().phase}`);
    });
  }

  private translationSnapshot(): TranslationSnapshot {
    return (
      this.engine?.snapshot() ?? {
        phase: 'idle',
        progress: 0,
        error: null,
        total: this.segments.length,
        translatedCount: 0,
        failedCount: 0,
        backendCalls: 0,
        sourceLanguage: '',
        targetLanguage: TARGET_LANGUAGE,
      }
    );
  }

  private fail(gen: number, e: unknown): void {
    if (gen !== this.generation) return;
    const err = toVyronError(e);
    this.status = 'error';
    this.error = err;
    this.note(`LỖI ${err.code}: ${err.message}`);
  }

  // ---------- Thông điệp từ popup ----------
  private handlePopupMessage(msg: PopupRequest): unknown {
    switch (msg.type) {
      case 'GET_STATE':
        return this.snapshot();
      case 'RETRY_TRANSLATION':
        void this.engine?.retry();
        return { ok: true };
      case 'RELOAD':
        this.generation++;
        this.resetData();
        void this.loadTracks(this.generation);
        return { ok: true };
    }
  }

  private snapshot(): StateSnapshot {
    return {
      status: this.status,
      videoId: this.videoId,
      error: this.error,
      tracks: this.tracks.map(({ baseUrl: _omit, ...info }) => info),
      selectedTrackIndex: this.selectedTrackIndex,
      fetchMethod: this.fetchMethod,
      fetchNote: this.fetchNote,
      segmentsVersion: this.segmentsVersion,
      stats: this.stats,
      playback: this.playback,
      currentSegmentIndex: this.currentSegmentIndex,
      translation: this.translationSnapshot(),
      translationVersion: this.translationVersion,
      speech: { ...this.speech.snapshot(), sync: this.driver.snapshot() },
    };
  }

  // ---------- HUD ----------
  private note(msg: string): void {
    const t = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    this.log.push(`${t} ${msg}`);
    if (this.log.length > 60) this.log.splice(0, this.log.length - 60);
  }

  private renderHud(): void {
    if (this.orphaned) return;
    this.renderPill();
    if (this.settings.debugHud) this.renderDebug();
  }

  /** Nhãn nhỏ trên khung video: chỉ nói điều người dùng cần biết. */
  private renderPill(): void {
    const tr = this.translationSnapshot();
    const sp = this.speech.snapshot();
    if (!this.videoId) return this.pill.clear();
    if (this.status === 'error') {
      const msg = this.error?.code === 'NO_CAPTION_TRACKS' ? 'Video này không có phụ đề' : 'Không lấy được phụ đề';
      return this.pill.show({ tone: 'error', text: msg });
    }
    if (this.status === 'loading') return this.pill.show({ tone: 'busy', text: 'Đang lấy phụ đề…' });
    if (this.status !== 'ready') return this.pill.clear();

    switch (tr.phase) {
      case 'needs-download':
        return this.pill.show({
          tone: 'warn',
          text: 'Cần tải gói dịch tiếng Việt (một lần)',
          sticky: true,
          action: { label: 'Tải về', onClick: () => void this.engine?.requestDownload() },
        });
      case 'downloading':
        return this.pill.show({ tone: 'busy', text: 'Đang tải gói tiếng Việt', detail: `${(tr.progress * 100).toFixed(0)}%`, sticky: true });
      case 'checking':
      case 'preparing':
        return this.pill.show({ tone: 'busy', text: 'Đang chuẩn bị bộ dịch…' });
      case 'unsupported':
      case 'error':
        return this.pill.show({ tone: 'error', text: 'Dịch không dùng được', detail: tr.error?.code ?? '' });
      default:
        break;
    }
    if (!this.settings.speechEnabled) return this.pill.clear();
    if (sp.status === 'no-vietnamese-voice') return this.pill.show({ tone: 'warn', text: 'Máy chưa có giọng tiếng Việt' });
    if (sp.status === 'only-network-voice') return this.pill.show({ tone: 'warn', text: 'Chỉ có giọng qua mạng, xem trong popup' });
    if (sp.needsActivation) return this.pill.show({ tone: 'warn', text: 'Bấm vào video một lần để bật giọng đọc' });
    if (sp.status !== 'ok') return this.pill.clear();
    const sync = this.driver.snapshot();
    const detail = `${sync.rate.toFixed(2).replace(/0$/, '')}x`;
    this.pill.show(
      sync.mode === 'catchup'
        ? { tone: 'busy', text: 'Đang tăng tốc để bắt kịp video', detail }
        : { tone: 'live', text: 'Đang đọc bản dịch', detail },
    );
  }

  private renderDebug(): void {
    const p = this.playback;
    const tr = this.translationSnapshot();
    const sp = this.speech.snapshot();
    const sync = this.driver.snapshot();
    const seg = this.currentSegmentIndex >= 0 ? this.segments[this.currentSegmentIndex] : undefined;
    const track = this.tracks[this.selectedTrackIndex];
    const lines: string[] = [
      `trạng thái: ${this.status}${this.error ? ` (${this.error.code})` : ''}   video: ${this.videoId ?? '-'}`,
      `track: ${track ? `${track.languageCode}/${track.kind}` : '-'}  qua: ${this.fetchMethod ?? '-'}  đoạn: ${this.stats?.count ?? 0}`,
      `giọng: ${sp.selectedVoice?.name ?? '-'} (${sp.status})${sp.speaking ? '  ĐANG ĐỌC' : ''}${sp.lastError ? `  lỗi: ${sp.lastError}` : ''}`,
      `đồng bộ: ${sync.mode}  rate ${sync.rate}x  trễ ${sync.lagSeconds}s  bỏ ${sync.skipped}  giọng đo được ${sync.unitsPerSecond} từ/s`,
      `dịch: ${tr.phase}${tr.phase === 'downloading' ? ` ${(tr.progress * 100).toFixed(0)}%` : ''}  ${tr.translatedCount}/${tr.total}${
        tr.failedCount ? ` lỗi ${tr.failedCount}` : ''
      }  gọi model ${tr.backendCalls}`,
      ...(tr.error && tr.phase !== 'ready' ? [`  ${tr.error.code}: ${tr.error.message}`] : []),
      p
        ? `t=${fmt(p.currentTime)}  ${p.paused ? 'PAUSED' : 'PLAYING'}  x${p.playbackRate}  seeking=${p.seeking}  ad=${p.adShowing}`
        : 't=-',
      seg
        ? `#${this.currentSegmentIndex} [${fmt(seg.startTime)}–${fmt(seg.endTime)}] ${seg.originalText}\n→ ${
            this.engine?.getTranslation(this.currentSegmentIndex) ?? '(chưa dịch)'
          }`
        : `đoạn hiện tại: ${p?.adShowing ? '(đang quảng cáo)' : '(không có)'}`,
      '--- sự kiện gần đây ---',
      ...this.log.slice(-8),
    ];
    this.hud.setText(lines.join('\n'));
  }
}

new VyronController().start();
