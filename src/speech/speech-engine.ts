/**
 * Bọc Web Speech API: một giọng đọc tại một thời điểm, không bao giờ phát chồng.
 * Engine KHÔNG tự cắt câu đang đọc để nhường chỗ (cắt giữa chừng là nguyên nhân bị mất/đứt chữ):
 * việc quyết định đọc gì, lúc nào do SpeechDriver đảm nhiệm; engine chỉ đọc và báo lại thời gian thật
 * (độ trễ khởi động, thời lượng đọc) để driver tự hiệu chỉnh.
 * Sự kiện của utterance đã bị hủy được nhận diện bằng token và bị bỏ qua.
 */
import type { VoiceInfo, VoiceStatus } from '../shared/types.ts';
import { pickEnglishVoice, pickVoice, vietnameseVoices } from './voice.ts';
import { splitByLanguage } from './lang-split.ts';
import { respellEnglish } from './respell.ts';
import type { SpeechPart } from './lang-split.ts';

export interface UtteranceLike {
  text: string;
  lang: string;
  voice: unknown;
  rate: number;
  volume: number;
  pitch?: number;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}
export interface SynthLike {
  speak(u: UtteranceLike): void;
  cancel(): void;
  resume?(): void;
  getVoices(): Array<VoiceInfo & Record<string, unknown>>;
  addEventListener(type: 'voiceschanged', cb: () => void): void;
}
export interface SpeechDeps {
  synth: SynthLike;
  createUtterance(text: string): UtteranceLike;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now?(): number;
}
export interface SpeakRequest {
  id: string;
  text: string;
  rate: number;
}
/** Sự kiện báo cho driver. `end` chỉ phát khi câu được đọc xong thật; `abort` khi lỗi/kẹt/bị bỏ. */
export type EngineEvent =
  | { kind: 'start'; id: string; latencyMs: number }
  | { kind: 'end'; id: string; durationMs: number }
  | { kind: 'abort'; id: string; reason: string };

const START_TIMEOUT_MS = 4000;
const MAX_UTTERANCE_MS = 30000; // Chrome đôi khi không bao giờ phát onend; quá hạn thì coi như xong để không kẹt
const VOICE_LOAD_TIMEOUT_MS = 2000;

type Voice = VoiceInfo & Record<string, unknown>;

export class SpeechEngine {
  private deps: SpeechDeps | null;
  private onChange: () => void;
  private voices: Voice[] = [];
  private voice: Voice | null = null;
  private status: VoiceStatus;
  private preferredName: string | null = null;
  private allowNetwork = false;
  private englishEnabled = true;
  private respellEnabled = false;
  private englishVoice: Voice | null = null;

  private current: { req: SpeakRequest; utterance: UtteranceLike } | null = null; // giữ tham chiếu: Chrome có thể ngừng đọc nếu utterance bị thu gom
  private token = 0;
  private isSpeaking = false;
  private lastError: string | null = null;
  private activationNeeded = false;
  private listener: ((e: EngineEvent) => void) | null = null;

  constructor(deps: SpeechDeps | null, onChange: () => void = () => {}) {
    this.deps = deps;
    this.onChange = onChange;
    this.status = deps ? 'loading' : 'unsupported';
  }

  setListener(fn: ((e: EngineEvent) => void) | null): void {
    this.listener = fn;
  }

  /** Nạp danh sách giọng. Chrome nạp bất đồng bộ nên có thể phải chờ sự kiện voiceschanged. */
  async init(): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    deps.synth.addEventListener('voiceschanged', () => this.refreshVoices());
    this.refreshVoices();
    if (this.voices.length > 0) return;
    await new Promise<void>((resolve) => {
      const h = deps.setTimeout(resolve, VOICE_LOAD_TIMEOUT_MS);
      deps.synth.addEventListener('voiceschanged', () => {
        deps.clearTimeout(h);
        resolve();
      });
    });
    this.refreshVoices();
  }

  configure(opts: { preferredName: string | null; allowNetwork: boolean; englishEnabled?: boolean; respellEnabled?: boolean }): void {
    this.preferredName = opts.preferredName;
    this.allowNetwork = opts.allowNetwork;
    this.englishEnabled = opts.englishEnabled ?? true;
    this.respellEnabled = opts.respellEnabled ?? false;
    this.repick();
    this.onChange();
  }

  private refreshVoices(): void {
    if (!this.deps) return;
    this.voices = this.deps.synth.getVoices();
    this.repick();
    this.onChange();
  }

  private repick(): void {
    if (!this.deps) return;
    if (this.voices.length === 0) {
      this.voice = null;
      this.status = 'loading';
      return;
    }
    const r = pickVoice(this.voices, { preferredName: this.preferredName, allowNetwork: this.allowNetwork });
    this.voice = r.voice;
    this.status = r.status;
    this.englishVoice = this.englishEnabled ? pickEnglishVoice(this.voices, { allowNetwork: this.allowNetwork }) : null;
  }

  get ready(): boolean {
    return !!this.deps && !!this.voice;
  }
  /** Đang có một câu được giao cho Chrome (chưa kết thúc). */
  get busy(): boolean {
    return this.current !== null;
  }
  get voiceName(): string | null {
    return this.voice?.name ?? null;
  }

  /** Đọc ngay. Nếu đang đọc dở câu khác thì câu đó bị hủy (driver chỉ làm vậy khi pause/tua). Trả false nếu không thể đọc. */
  speak(req: SpeakRequest): boolean {
    const deps = this.deps;
    const voice = this.voice;
    if (!deps || !voice) return false;
    if (this.current) this.cancelInternal();
    const token = ++this.token;
    const now = () => deps.now?.() ?? Date.now();
    // Từ tiếng Anh xen trong câu tiếng Việt dùng giọng tiếng Anh (nếu máy có); không có thì cả câu đọc bằng giọng Việt.
    // Từ tiếng Anh thông dụng được phiên âm kiểu Việt trước, để giọng Việt đọc liền mạch mà không phải đổi giọng.
    const text = this.respellEnabled ? respellEnglish(req.text) : req.text;
    const parts: SpeechPart[] = this.englishVoice ? splitByLanguage(text) : [{ text, lang: 'vi' }];
    if (parts.length === 0) parts.push({ text, lang: 'vi' });
    const rate = Math.min(2, Math.max(0.5, req.rate));
    const utterances = parts.map((p) => {
      const u = deps.createUtterance(p.text);
      const v = p.lang === 'en' && this.englishVoice ? this.englishVoice : voice;
      u.voice = v;
      u.lang = v.lang;
      u.rate = rate;
      u.volume = 1; // mức tối đa mà Web Speech cho phép
      if ('pitch' in u) u.pitch = 1;
      return u;
    });
    const first = utterances[0]!;
    const last = utterances[utterances.length - 1]!;
    const requestedAt = now();
    let startedAt = 0;
    let started = false;
    let startWatch: unknown = null;
    let endWatch: unknown = null;
    const clearWatch = () => {
      if (startWatch !== null) deps.clearTimeout(startWatch);
      if (endWatch !== null) deps.clearTimeout(endWatch);
      startWatch = endWatch = null;
    };
    const finish = (event: EngineEvent) => {
      clearWatch();
      this.current = null;
      this.setSpeaking(false);
      this.listener?.(event);
    };

    startWatch = deps.setTimeout(() => {
      if (token !== this.token || started) return;
      this.token++; // bỏ utterance bị kẹt để driver có thể thử câu khác
      this.lastError = 'Giọng đọc không bắt đầu (hết thời gian chờ).';
      deps.synth.cancel();
      finish({ kind: 'abort', id: req.id, reason: 'start-timeout' });
    }, START_TIMEOUT_MS);

    first.onstart = () => {
      if (token !== this.token) return;
      started = true;
      startedAt = now();
      if (startWatch !== null) deps.clearTimeout(startWatch);
      startWatch = null;
      endWatch = deps.setTimeout(() => {
        if (token !== this.token) return;
        this.token++;
        deps.synth.cancel();
        finish({ kind: 'end', id: req.id, durationMs: now() - startedAt });
      }, MAX_UTTERANCE_MS);
      this.lastError = null;
      this.activationNeeded = false;
      this.setSpeaking(true);
      this.listener?.({ kind: 'start', id: req.id, latencyMs: startedAt - requestedAt });
    };
    last.onend = () => {
      if (token !== this.token) return;
      const ended = now();
      finish({ kind: 'end', id: req.id, durationMs: started ? ended - startedAt : 0 });
    };
    const onError = (e: { error?: string }) => {
      if (token !== this.token) return;
      const err = e?.error ?? 'unknown';
      if (err !== 'canceled' && err !== 'interrupted') {
        this.lastError = err;
        this.activationNeeded = err === 'not-allowed';
      }
      if (utterances.length > 1) deps.synth.cancel(); // bỏ các đoạn còn lại trong hàng đợi
      finish({ kind: 'abort', id: req.id, reason: err });
    };
    for (const u of utterances) u.onerror = onError;

    this.current = { req, utterance: first };
    deps.synth.resume?.(); // Chrome đôi khi kẹt ở trạng thái paused sau nhiều lần cancel
    for (const u of utterances) deps.synth.speak(u); // Chrome tự xếp hàng, đọc lần lượt từng đoạn
    return true;
  }

  cancel(): void {
    this.cancelInternal();
    this.setSpeaking(false);
  }

  private cancelInternal(): void {
    this.token++; // vô hiệu hóa mọi sự kiện muộn của utterance cũ
    this.current = null;
    this.deps?.synth.cancel();
  }

  private setSpeaking(v: boolean): void {
    this.isSpeaking = v;
    this.onChange();
  }

  get speaking(): boolean {
    return this.isSpeaking;
  }

  snapshot(): {
    status: VoiceStatus;
    voices: VoiceInfo[];
    selectedVoice: VoiceInfo | null;
    englishVoice: VoiceInfo | null;
    speaking: boolean;
    lastError: string | null;
    needsActivation: boolean;
  } {
    return {
      status: this.status,
      voices: vietnameseVoices(this.voices).map((v) => ({ name: v.name, lang: v.lang, localService: v.localService })),
      selectedVoice: this.voice ? { name: this.voice.name, lang: this.voice.lang, localService: this.voice.localService } : null,
      englishVoice: this.englishVoice ? { name: this.englishVoice.name, lang: this.englishVoice.lang, localService: this.englishVoice.localService } : null,
      speaking: this.isSpeaking,
      lastError: this.lastError,
      needsActivation: this.activationNeeded,
    };
  }
}
