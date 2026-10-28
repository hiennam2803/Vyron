import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpeechDriver } from '../src/speech/speech-driver.ts';
import type { DriverSegment } from '../src/speech/speech-driver.ts';
import { countSpeechUnits } from '../src/speech/pacing.ts';

/**
 * Mô phỏng một video + giọng đọc giả có tốc độ và độ trễ khởi động thật, để kiểm tra HÀNH VI TỔNG THỂ của bộ đồng bộ
 * (không chỉ từng hàm): trễ tối đa, số đoạn bị bỏ, tốc độ cao nhất, và không bao giờ cắt giữa câu.
 * Đây là mô hình, không phải Chrome thật: ý nghĩa là chống hồi quy, không phải bảo chứng chất lượng giọng.
 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface SimOptions {
  wpsOfSpeaker: number; // từ/giây của bản dịch trong video
  voiceWps: number; // từ/giây thật của giọng ở 1.0x
  latencyMs: number;
  playbackRate: number;
  seconds: number;
  seed: number;
}

function simulate(o: SimOptions) {
  const rand = rng(o.seed);
  const segs: DriverSegment[] = [];
  const texts: string[] = [];
  let t = 0;
  while (t < o.seconds) {
    const dur = 1.2 + rand() * 3.8;
    const words = Math.max(2, Math.round(dur * o.wpsOfSpeaker * (0.7 + rand() * 0.6)));
    segs.push({ startTime: t, endTime: t + dur });
    texts.push(Array.from({ length: words }, (_, i) => `t${i}`).join(' '));
    t += dur + (rand() < 0.3 ? rand() * 1.5 : 0); // đôi khi có khoảng lặng
  }

  type Pending = { id: string; startAt: number; endAt: number; started: boolean };
  let pending = null as Pending | null;
  let now = 0;
  let videoT = 0;
  const STEP = 0.05;
  const speech = {
    busy: false,
    voiceName: 'sim' as string | null,
    cancels: 0,
    maxRate: 0,
    lastReq: null as null | { id: string; text: string; rate: number },
    utterances: [] as Array<{ first: number; startedAt: number; rate: number }>,
    speak(r: { id: string; text: string; rate: number }) {
      this.busy = true;
      this.lastReq = r;
      this.maxRate = Math.max(this.maxRate, r.rate);
      const units = countSpeechUnits(r.text);
      const startAt = now + o.latencyMs / 1000;
      const endAt = startAt + units / (o.voiceWps * r.rate);
      pending = { id: r.id, startAt, endAt, started: false };
      const m = /^s(\d+)-/.exec(r.id);
      this.utterances.push({ first: Number(m![1]), startedAt: startAt, rate: r.rate });
      return true;
    },
    cancel() {
      this.cancels++;
      this.busy = false;
      pending = null;
    },
  };
  const driver = new SpeechDriver({
    speech,
    getDucker: () => null,
    getSegments: () => segs,
    getTranslation: (i) => texts[i] ?? null,
    getSettings: () => ({ speechEnabled: true, duckLevel: 0.15 }),
  });
  driver.onPlay();
  const end = segs.at(-1)!.endTime + 40;
  while (videoT < end) {
    now += STEP / o.playbackRate; // giây thực
    videoT += STEP;
    if (pending && !pending.started && now >= pending.startAt) {
      pending.started = true;
      driver.onEngineEvent({ kind: 'start', id: pending.id, latencyMs: o.latencyMs });
    }
    if (pending && pending.started && now >= pending.endAt) {
      const p = pending;
      pending = null;
      speech.busy = false;
      driver.onEngineEvent({ kind: 'end', id: p.id, durationMs: (p.endAt - p.startAt) * 1000 });
    }
    driver.onTime(videoT, o.playbackRate);
  }

  // Độ lệch giữa lúc giọng bắt đầu vang lên và lúc đoạn bắt đầu trên video (giây thực; âm = đọc sớm)
  const offsets = speech.utterances
    .map((u) => u.startedAt - segs[u.first]!.startTime / o.playbackRate)
    .sort((a, b) => a - b);
  const pct = (p: number) => offsets[Math.min(offsets.length - 1, Math.floor(offsets.length * p))] ?? 0;
  return { segs, speech, snap: driver.snapshot(), total: segs.length, p50: pct(0.5), p90: pct(0.9) };
}

const CASES: Array<[string, Partial<SimOptions>]> = [
  ['người nói bình thường, giọng nhanh vừa', { wpsOfSpeaker: 2.6, voiceWps: 3.6 }],
  ['người nói nhanh, giọng chậm', { wpsOfSpeaker: 3.4, voiceWps: 2.8 }],
  ['video xem 1.5x', { wpsOfSpeaker: 2.6, voiceWps: 3.4, playbackRate: 1.5 }],
  ['video xem 2x (cực đoan)', { wpsOfSpeaker: 2.6, voiceWps: 3.4, playbackRate: 2 }],
  ['độ trễ khởi động cao (giọng qua mạng)', { wpsOfSpeaker: 2.8, voiceWps: 3.4, latencyMs: 600 }],
];

for (const [name, over] of CASES) {
  test(`mô phỏng đồng bộ: ${name}`, () => {
    const r = simulate({ wpsOfSpeaker: 2.8, voiceWps: 3.4, latencyMs: 250, playbackRate: 1, seconds: 240, seed: 7, ...over });
    const skipRatio = r.snap.skipped / r.total;
    if (process.env.SIM_VERBOSE) console.log(`${name}: bỏ ${(skipRatio * 100).toFixed(0)}% · rate max ${r.speech.maxRate} · lệch p50 ${r.p50.toFixed(2)}s p90 ${r.p90.toFixed(2)}s`);
    // Không bao giờ ngắt câu đang đọc trong lúc phát liên tục
    assert.equal(r.speech.cancels, 0, 'không được cancel giữa chừng khi phát liên tục');
    // Tốc độ không vượt trần
    assert.ok(r.speech.maxRate <= 1.9 + 1e-9, `rate cao nhất ${r.speech.maxRate}`);
    // Phần lớn đoạn được đọc (case cực đoan cho phép bỏ nhiều hơn)
    const limit = name.includes('cực đoan') ? 0.5 : name.includes('chậm') ? 0.35 : 0.2;
    assert.ok(skipRatio <= limit, `bỏ ${(skipRatio * 100).toFixed(0)}% đoạn (${r.snap.skipped}/${r.total})`);
    // Giọng vang lên gần đúng lúc đoạn bắt đầu (đa số câu lệch dưới 1.5 giây thực)
    assert.ok(r.p50 < 1.5, `lệch trung vị ${r.p50.toFixed(2)}s`);
    // Không tụt lại quá xa: cuối video, trễ vẫn nhỏ
    assert.ok(r.snap.lagSeconds < 5, `trễ cuối ${r.snap.lagSeconds}s`);
  });
}
