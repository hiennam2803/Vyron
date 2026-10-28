/**
 * Bộ điều phối giọng đọc: quyết định ĐỌC GÌ, KHI NÀO, NHANH BAO NHIÊU để khớp video.
 *
 * Nguyên tắc cốt lõi:
 * 1. Không bao giờ cắt câu đang đọc để nhường câu mới (cắt giữa chừng gây đứt chữ, mất chữ).
 *    Chỉ pause / tua / quảng cáo / tắt đọc mới dừng giọng ngay.
 * 2. Tốc độ KHÔNG đặt cố định: mỗi câu tính tốc độ cần để đọc xong trước khi đoạn kế tiếp bắt đầu,
 *    dựa trên tốc độ đọc thật của giọng (đo liên tục) và tốc độ phát của video.
 * 3. Hai chế độ tự chuyển (có độ trễ chuyển để không nhấp nháy):
 *    - natural: đọc từng đoạn, tốc độ 1.0–1.5x, nghe tự nhiên.
 *    - catchup: khi trễ quá ~1.5 giây hoặc dồn nhiều đoạn, gộp các đoạn đến hạn thành một câu liền mạch,
 *      tăng tốc tới 1.75x, và chỉ bỏ nguyên những đoạn đã quá cũ (không bao giờ bỏ nửa câu).
 * 4. Bắt đầu đọc sớm hơn một chút đúng bằng độ trễ khởi động đo được của giọng, để tiếng vang lên đúng lúc đoạn bắt đầu.
 */
import type { EngineEvent } from './speech-engine.ts';
import { findAnchorIndex } from '../content/transcript-manager.ts';
import { PaceModel, RATE_HARD, RATE_MIN, RATE_SOFT, countSpeechUnits, planRate } from './pacing.ts';
import { toSpeakable } from './speakable.ts';

export interface DriverSegment {
  startTime: number;
  endTime: number;
}
export interface DriverSpeech {
  speak(req: { id: string; text: string; rate: number }): boolean;
  cancel(): void;
  readonly busy: boolean;
  readonly voiceName: string | null;
}
export interface DriverDucker {
  duck(level: number): void;
  release(delayMs: number): void;
  restoreNow(): void;
}
export interface DriverSettings {
  speechEnabled: boolean;
  duckLevel: number;
  /** Câu ≤ chừng này từ thì bỏ dấu câu để đọc lướt. Bỏ trống = mặc định. */
  shortSentenceWords?: number;
  /** Tốc độ đọc tối đa khi bắt kịp video. Bỏ trống = RATE_HARD. */
  maxRate?: number;
}
export interface DriverDeps {
  speech: DriverSpeech;
  getDucker(): DriverDucker | null;
  getSegments(): readonly DriverSegment[];
  getTranslation(index: number): string | null;
  getSettings(): DriverSettings;
}

export type SyncMode = 'natural' | 'catchup';
export interface SyncSnapshot {
  mode: SyncMode;
  rate: number; // tốc độ của câu gần nhất
  lagSeconds: number; // giây thực mà giọng đọc đang chậm so với đoạn phụ đề
  skipped: number; // số đoạn bị bỏ nguyên vì quá cũ
  unitsPerSecond: number; // tốc độ đọc đo được của giọng ở 1.0x
}

export const RELEASE_DELAY_MS = 600;
const LAG_ENTER = 1.5; // giây thực: trễ hơn mức này thì vào catchup
const LAG_EXIT = 0.5;
const STALE_NATURAL = 3.0; // đoạn đã kết thúc quá lâu này (giây thực) thì bỏ
const STALE_CATCHUP = 1.5;
const LATE_FRACTION_SKIP = 0.6; // bắt đầu đọc khi đoạn đã trôi qua quá 60% thì bỏ, vì phần lớn đã qua
const BACKLOG_ENTER = 3; // từ ngần này đoạn đã đến hạn cùng lúc thì vào catchup
const MERGE_MAX_SEGMENTS = 3;
const MERGE_MAX_UNITS = 34;

export class SpeechDriver {
  private d: DriverDeps;
  private pace = new PaceModel();
  private voiceSeen: string | null = null;

  private playing = false;
  private adShowing = false;
  private seeking = false;
  private videoTime = 0;
  private playbackRate = 1;
  private lastTime: number | null = null;

  private next = -1; // đoạn kế tiếp cần xét; -1 = chưa xác định vị trí
  private inflight: { first: number; last: number; units: number; rate: number; id: string } | null = null;
  private seq = 0;

  private mode: SyncMode = 'natural';
  private lastRate = 1;
  private lag = 0;
  private skipped = 0;

  constructor(deps: DriverDeps) {
    this.d = deps;
  }

  // ---------- Sự kiện từ trang ----------
  onTime(currentTime: number, playbackRate: number): void {
    if (!Number.isFinite(currentTime)) return;
    const jumpedBack = this.lastTime !== null && currentTime < this.lastTime - 0.75;
    const jumpedFar = this.lastTime !== null && currentTime > this.lastTime + 6;
    this.lastTime = currentTime;
    this.videoTime = currentTime;
    this.playbackRate = Number.isFinite(playbackRate) ? Math.min(4, Math.max(0.25, playbackRate)) : 1;
    if ((jumpedBack || jumpedFar) && !this.seeking) this.reposition();
    this.pump();
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    if (!playing) this.stopSpeaking();
    else this.pump();
  }

  onPlay(): void {
    this.setPlaying(true);
  }

  onPause(): void {
    if (this.inflight) this.next = this.inflight.first; // resume sẽ đọc lại câu đang dở từ đầu
    this.inflight = null;
    this.setPlaying(false);
  }

  onSeeking(): void {
    this.seeking = true;
    this.inflight = null;
    this.next = -1;
    this.stopSpeaking();
  }

  onSeeked(): void {
    this.seeking = false;
    this.next = -1;
    this.pump();
  }

  onAd(showing: boolean): void {
    if (showing === this.adShowing) return;
    this.adShowing = showing;
    if (showing) {
      this.inflight = null;
      this.stopSpeaking();
    }
    this.next = -1;
    if (!showing) this.pump();
  }

  /** Đổi video/track/danh sách đoạn. */
  reset(): void {
    this.next = -1;
    this.inflight = null;
    this.mode = 'natural';
    this.lastRate = 1;
    this.lag = 0;
    this.skipped = 0;
    this.lastTime = null;
    this.stopSpeaking();
  }

  onTranslationsChanged(): void {
    this.pump();
  }

  onSettingsChanged(): void {
    if (!this.d.getSettings().speechEnabled) {
      this.inflight = null;
      this.next = -1;
      this.stopSpeaking();
    } else {
      // Đang đọc dở một câu thì giữ nguyên vị trí: đặt lại sẽ làm câu vừa đọc xong bị đọc lại lần nữa
      // (con trỏ quay về đoạn đang phát). Cài đặt mới tự áp dụng từ câu sau.
      if (!this.inflight) this.next = -1;
      this.pump();
    }
  }

  /** Engine giọng đọc bắt đầu/ngừng đọc: điều khiển hạ/trả âm lượng video. */
  onSpeakingChanged(speaking: boolean): void {
    const s = this.d.getSettings();
    const ducker = this.d.getDucker();
    if (!ducker) return;
    if (speaking && s.speechEnabled) ducker.duck(s.duckLevel);
    else ducker.release(RELEASE_DELAY_MS);
  }

  /** Nhận sự kiện thời gian thật từ engine để tự hiệu chỉnh và đọc tiếp. */
  onEngineEvent(e: EngineEvent): void {
    const cur = this.inflight;
    if (!cur || cur.id !== e.id) return;
    if (e.kind === 'start') {
      this.pace.recordLatency(e.latencyMs);
      return;
    }
    if (e.kind === 'end') this.pace.recordUtterance(cur.units, cur.rate, e.durationMs);
    this.inflight = null;
    this.pump();
  }

  snapshot(): SyncSnapshot {
    return {
      mode: this.mode,
      rate: this.lastRate,
      lagSeconds: Math.round(this.lag * 10) / 10,
      skipped: this.skipped,
      unitsPerSecond: Math.round(this.pace.unitsPerSecond * 10) / 10,
    };
  }

  // ---------- Nội bộ ----------
  private stopSpeaking(): void {
    this.d.speech.cancel();
    this.d.getDucker()?.restoreNow();
  }

  private reposition(): void {
    this.inflight = null;
    this.next = -1;
    this.stopSpeaking();
  }

  private pump(): void {
    const s = this.d.getSettings();
    if (!s.speechEnabled || !this.playing || this.adShowing || this.seeking) return;
    const segs = this.d.getSegments();
    if (segs.length === 0 || this.lastTime === null) return; // chưa biết video đang ở đâu

    const voice = this.d.speech.voiceName;
    if (voice !== this.voiceSeen) {
      this.voiceSeen = voice;
      this.pace.reset(); // giọng khác -> tốc độ đo được không còn đúng
    }

    const t = this.videoTime;
    const r = this.playbackRate;
    if (this.next < 0) this.next = findAnchorIndex(segs, t);

    if (this.inflight) {
      // Không bao giờ ngắt câu đang đọc. Chỉ cập nhật mức trễ để hiển thị.
      const end = segs[this.inflight.last]?.endTime ?? t;
      this.lag = Math.max(0, (t - end) / r);
      return;
    }
    if (this.d.speech.busy) return;

    const lead = this.pace.startLatencySeconds * r; // giây video: bắt đầu sớm để tiếng vang lên đúng lúc
    for (let guard = 0; guard < 64; guard++) {
      if (this.next >= segs.length) {
        this.lag = 0;
        return;
      }
      const i = this.next;
      const seg = segs[i]!;
      if (seg.startTime > t + lead) {
        this.lag = 0; // chưa đến hạn
        return;
      }

      const lagReal = Math.max(0, t - seg.startTime) / r;
      const overReal = (t - seg.endTime) / r;
      const dueCount = this.countDue(segs, i, t + lead);

      // Chuyển chế độ (có độ trễ chuyển)
      if (this.mode === 'natural' && (lagReal > LAG_ENTER || dueCount >= BACKLOG_ENTER)) this.mode = 'catchup';
      else if (this.mode === 'catchup' && lagReal < LAG_EXIT && dueCount <= 1) this.mode = 'natural';
      this.lag = lagReal;

      // Đoạn đã kết thúc quá lâu: bỏ nguyên đoạn (không bao giờ bỏ nửa câu)
      const staleLimit = this.mode === 'catchup' ? STALE_CATCHUP : STALE_NATURAL;
      if (overReal > staleLimit && i + 1 < segs.length) {
        this.next++;
        this.skipped++;
        continue;
      }

      const translation = this.d.getTranslation(i);
      if (translation === null) {
        if (dueCount > 1 && lagReal > 1.5) {
          this.next++; // bản dịch chưa về mà đoạn sau đã tới hạn: không chờ mãi
          this.skipped++;
          continue;
        }
        return; // đợi bản dịch về (onTranslationsChanged)
      }
      const text = toSpeakable(translation, true, s.shortSentenceWords);
      if (!text) {
        this.next++; // nhãn âm thanh như [âm nhạc]: bỏ qua, không tính là đã bỏ
        continue;
      }

      // Đang ở GIỮA đoạn và phần lớn đã trôi qua (thường sau khi tua hoặc resume): đọc nữa chỉ thêm lệch.
      // Đoạn đã qua hẳn thì không xét ở đây: để cơ chế bắt kịp / bỏ đoạn cũ ở trên quyết định.
      const dur = Math.max(0.3, seg.endTime - seg.startTime);
      if (t < seg.endTime && (t - seg.startTime) / dur > LATE_FRACTION_SKIP && i + 1 < segs.length) {
        this.next++;
        continue;
      }

      this.speakChunk(segs, i, text, t + lead);
      return;
    }
  }

  private countDue(segs: readonly DriverSegment[], from: number, until: number): number {
    let n = 0;
    for (let i = from; i < segs.length && segs[i]!.startTime <= until; i++) n++;
    return n;
  }

  private speakChunk(segs: readonly DriverSegment[], first: number, firstText: string, dueUntil: number): void {
    let last = first;
    const parts = [firstText];
    let units = countSpeechUnits(firstText);

    if (this.mode === 'catchup') {
      // Gộp các đoạn đã đến hạn thành một câu liền mạch: bớt các khoảng nghỉ giữa câu và độ trễ khởi động.
      while (last + 1 < segs.length && last - first + 1 < MERGE_MAX_SEGMENTS && segs[last + 1]!.startTime <= dueUntil) {
        const tr = this.d.getTranslation(last + 1);
        if (tr === null) break;
        const txt = toSpeakable(tr, true, this.d.getSettings().shortSentenceWords);
        if (!txt) {
          last++; // nhãn âm thanh nằm giữa: bỏ qua nhưng vẫn coi là đã qua
          continue;
        }
        const u = countSpeechUnits(txt);
        if (units + u > MERGE_MAX_UNITS) break;
        parts.push(txt);
        units += u;
        last++;
      }
    }

    const r = this.playbackRate;
    const limitVideo = last + 1 < segs.length ? segs[last + 1]!.startTime : segs[last]!.endTime + 2;
    const available = (limitVideo - this.videoTime) / r - this.pace.startLatencySeconds;
    const maxRate = this.d.getSettings().maxRate ?? RATE_HARD;
    const plan = planRate({
      model: this.pace,
      units,
      availableSeconds: available,
      previousRate: this.lastRate,
      ceiling: this.mode === 'catchup' ? maxRate : Math.min(RATE_SOFT, maxRate),
    });

    const id = `s${first}-${last}#${++this.seq}`;
    const s = this.d.getSettings();
    this.d.getDucker()?.duck(s.duckLevel); // hạ âm lượng video TRƯỚC khi giọng vang lên để không nuốt âm đầu
    const ok = this.d.speech.speak({ id, text: parts.join(' '), rate: Math.max(RATE_MIN, plan.rate) });
    if (!ok) return; // chưa có giọng: giữ nguyên vị trí, sẽ thử lại khi có giọng
    this.inflight = { first, last, units, rate: plan.rate, id };
    this.lastRate = plan.rate;
    this.next = last + 1;
  }
}
