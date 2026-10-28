import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSpeakable } from '../src/speech/speakable.ts';
import { pickVoice } from '../src/speech/voice.ts';
import { SpeechEngine } from '../src/speech/speech-engine.ts';
import type { EngineEvent, SpeechDeps, SynthLike, UtteranceLike } from '../src/speech/speech-engine.ts';
import { VolumeDucker } from '../src/speech/ducking.ts';
import type { MediaLike, Timers } from '../src/speech/ducking.ts';
import { RELEASE_DELAY_MS, SpeechDriver } from '../src/speech/speech-driver.ts';
import type { DriverSegment } from '../src/speech/speech-driver.ts';
import { PaceModel, RATE_HARD, RATE_SOFT, countSpeechUnits, planRate } from '../src/speech/pacing.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/user-settings.ts';
import type { UserSettings } from '../src/shared/user-settings.ts';
import type { VoiceInfo } from '../src/shared/types.ts';

// ---------- toSpeakable ----------
test('toSpeakable: bỏ nhãn âm thanh, ký hiệu nhạc và >>', () => {
  assert.equal(toSpeakable('[âm nhạc]'), '');
  assert.equal(toSpeakable('[Music]'), '');
  assert.equal(toSpeakable('>> [vỗ tay] Chào mọi người'), 'Chào mọi người');
  assert.equal(toSpeakable('♪ ♪'), '');
  assert.equal(toSpeakable('(cười)'), '');
  assert.equal(toSpeakable('  Xin   chào  '), 'Xin chào');
});
test('toSpeakable: bỏ ngoặc, ngoặc kép, gạch ngang nhưng giữ nội dung', () => {
  assert.equal(toSpeakable('Hà Nội (thủ đô) rất đẹp'), 'Hà Nội thủ đô rất đẹp');
  assert.equal(toSpeakable('Anh ấy nói "được rồi" — và đi'), 'Anh ấy nói được rồi và đi');
});
test('toSpeakable: câu dài giữ nguyên dấu câu để giọng ngắt nghỉ bình thường', () => {
  assert.equal(
    toSpeakable('Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị, đó là âm nhạc.'),
    'Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị, đó là âm nhạc.',
  );
  assert.equal(toSpeakable('Chúng ta bắt đầu từ đâu nhỉ?'), 'Chúng ta bắt đầu từ đâu nhỉ?');
  assert.equal(
    toSpeakable('Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị, đó là âm nhạc. Ok?'),
    'Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị, đó là âm nhạc. Ok',
  );
});
test('toSpeakable: câu ngắn bỏ dấu câu để đọc lướt liền mạch', () => {
  assert.equal(toSpeakable('Oh my god. Oh no. Oh no.'), 'Oh my god Oh no Oh no');
  assert.equal(toSpeakable('Ôi trời ơi. Thôi xong. Thôi xong!'), 'Ôi trời ơi Thôi xong Thôi xong');
  assert.equal(toSpeakable('Xin chào, các bạn. Hôm nay trời đẹp!'), 'Xin chào các bạn Hôm nay trời đẹp');
  assert.equal(toSpeakable('Thật à?! Không thể nào...'), 'Thật à Không thể nào');
  assert.equal(toSpeakable('Một; hai: ba…'), 'Một hai ba');
  // câu dài xen câu ngắn: câu dài giữ dấu, câu ngắn bỏ dấu
  assert.equal(
    toSpeakable('Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị. Oh no. Thôi xong.'),
    'Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị. Oh no Thôi xong',
  );
});
test('toSpeakable: ngưỡng câu ngắn chỉnh được', () => {
  // "Xin chào các bạn." có 4 từ
  assert.equal(toSpeakable('Xin chào các bạn.', true, 3), 'Xin chào các bạn.'); // dài hơn ngưỡng -> giữ dấu
  assert.equal(toSpeakable('Xin chào các bạn.', true, 4), 'Xin chào các bạn'); // bằng ngưỡng -> bỏ dấu
  assert.equal(toSpeakable('Oh no. Oh my god.', true, 0), 'Oh no. Oh my god.'); // 0 = luôn giữ dấu
  assert.equal(toSpeakable('Oh no. Oh my god.', true, 12), 'Oh no Oh my god');
});
test('toSpeakable: đọc số thành chữ, không đọc từng chữ số', () => {
  assert.equal(toSpeakable('Giá là 3.5 triệu, tức 1,000 đô.'), 'Giá là ba phẩy năm triệu, tức một nghìn đô.');
  assert.equal(toSpeakable('Từ 10:30 đến 11:45.'), 'Từ mười giờ ba mươi đến mười một giờ bốn mươi lăm.');
  assert.equal(toSpeakable('Nó có giá 10.000 đô'), 'Nó có giá mười nghìn đô');
});
test('toSpeakable: chỉ toàn dấu câu thì không đọc gì', () => {
  assert.equal(toSpeakable('... ?! —'), '');
});
test('toSpeakable: tắt skipSoundLabels thì giữ nhãn (bỏ ngoặc vuông) nhưng vẫn bỏ >>', () => {
  assert.equal(toSpeakable('>> [âm nhạc]', false), 'âm nhạc');
  assert.equal(toSpeakable('>>', false), '');
});

// ---------- pickVoice: thứ tự Hoài My > Nam Minh > Microsoft An ----------
const HM = 'Microsoft HoaiMy Online (Natural) - Vietnamese (Vietnam)';
const NM = 'Microsoft NamMinh Online (Natural) - Vietnamese (Vietnam)';
const AN = 'Microsoft An - Vietnamese (Vietnam)';
test('pickVoice: ưu tiên Hoài My, rồi Nam Minh, rồi Microsoft An', () => {
  const all = [v(AN, 'vi-VN', true), v(NM, 'vi-VN', false), v(HM, 'vi-VN', false), v('Google VN', 'vi-VN', false)];
  const opts = { preferredName: null, allowNetwork: true };
  assert.equal(pickVoice(all, opts).voice?.name, HM);
  assert.equal(pickVoice(all.filter((x) => x.name !== HM), opts).voice?.name, NM);
  assert.equal(pickVoice(all.filter((x) => x.name !== HM && x.name !== NM), opts).voice?.name, AN);
  // tắt giọng qua mạng: chỉ còn giọng trên máy
  assert.equal(pickVoice(all, { preferredName: null, allowNetwork: false }).voice?.name, AN);
  // giọng chọn tay luôn được ưu tiên nhất
  assert.equal(pickVoice(all, { preferredName: NM, allowNetwork: true }).voice?.name, NM);
});
test('pickVoice: nhận ra tên có dấu "Hoài My" và không nhầm "Microsoft Anh" với Microsoft An', () => {
  const r = pickVoice([v('Microsoft Anh - Vietnamese', 'vi-VN', true), v('Hoài My', 'vi-VN', false)], { preferredName: null, allowNetwork: true });
  assert.equal(r.voice?.name, 'Hoài My');
});

// ---------- pickVoice ----------
const v = (name: string, lang: string, localService: boolean): VoiceInfo => ({ name, lang, localService });
test('pickVoice: ưu tiên giọng chạy trên máy', () => {
  const r = pickVoice([v('Google VN', 'vi-VN', false), v('Microsoft An', 'vi-VN', true), v('Zira', 'en-US', true)], { preferredName: null, allowNetwork: true });
  assert.equal(r.voice?.name, 'Microsoft An');
});
test('pickVoice: không có giọng tiếng Việt', () => {
  assert.equal(pickVoice([v('Zira', 'en-US', true)], { preferredName: null, allowNetwork: false }).status, 'no-vietnamese-voice');
});
test('pickVoice: chỉ có giọng qua mạng thì không dùng nếu chưa cho phép', () => {
  const voices = [v('Google VN', 'vi-VN', false)];
  assert.equal(pickVoice(voices, { preferredName: null, allowNetwork: false }).status, 'only-network-voice');
  assert.equal(pickVoice(voices, { preferredName: null, allowNetwork: true }).voice?.name, 'Google VN');
});
test('pickVoice: tôn trọng giọng đã chọn; giọng qua mạng đã chọn bị bỏ khi không cho phép', () => {
  const voices = [v('A', 'vi-VN', true), v('B', 'vi-VN', true), v('N', 'vi_VN', false)];
  assert.equal(pickVoice(voices, { preferredName: 'B', allowNetwork: false }).voice?.name, 'B');
  assert.equal(pickVoice(voices, { preferredName: 'N', allowNetwork: false }).voice?.name, 'A');
});

// ---------- SpeechEngine ----------
class FakeUtterance implements UtteranceLike {
  text: string; lang = ''; voice: unknown = null; rate = 1; volume = 1;
  onstart: (() => void) | null = null; onend: (() => void) | null = null; onerror: ((e: { error?: string }) => void) | null = null;
  constructor(text: string) { this.text = text; }
}
class FakeSynth implements SynthLike {
  spoken: FakeUtterance[] = []; cancels = 0; resumes = 0; voices: Array<VoiceInfo & Record<string, unknown>> = [];
  speak(u: UtteranceLike) { this.spoken.push(u as FakeUtterance); }
  cancel() { this.cancels++; }
  resume() { this.resumes++; }
  getVoices() { return this.voices; }
  addEventListener() {}
}
function makeEngine(voices: VoiceInfo[] = [v('An', 'vi-VN', true)]) {
  const synth = new FakeSynth();
  synth.voices = voices as Array<VoiceInfo & Record<string, unknown>>;
  const timers: Array<{ fn: () => void; ms: number; id: number; live: boolean }> = [];
  let clock = 0;
  const deps: SpeechDeps = {
    synth, createUtterance: (t) => new FakeUtterance(t),
    setTimeout: (fn, ms) => { const e = { fn, ms, id: timers.length, live: true }; timers.push(e); return e.id; },
    clearTimeout: (h) => { const e = timers[h as number]; if (e) e.live = false; },
    now: () => clock,
  };
  let changes = 0;
  const events: EngineEvent[] = [];
  const engine = new SpeechEngine(deps, () => { changes++; });
  engine.setListener((e) => events.push(e));
  engine.configure({ preferredName: null, allowNetwork: false });
  return { engine, synth, timers, events, advance: (ms: number) => { clock += ms; }, changes: () => changes };
}
const req = (id: string, rate = 1) => ({ id, text: id, rate });

test('SpeechEngine: nạp giọng, chọn giọng tiếng Việt chạy trên máy', async () => {
  const { engine } = makeEngine([v('Zira', 'en-US', true), v('An', 'vi-VN', true)]);
  await engine.init();
  const s = engine.snapshot();
  assert.equal(s.status, 'ok');
  assert.equal(s.selectedVoice?.name, 'An');
  assert.deepEqual(s.voices.map((x) => x.name), ['An']);
});
test('SpeechEngine: không có giọng tiếng Việt -> speak trả false, không đọc gì', async () => {
  const { engine, synth } = makeEngine([v('Zira', 'en-US', true)]);
  await engine.init();
  assert.equal(engine.snapshot().status, 'no-vietnamese-voice');
  assert.equal(engine.speak(req('a')), false);
  assert.equal(synth.spoken.length, 0);
});
test('SpeechEngine: không có Web Speech API -> unsupported', () => {
  const e = new SpeechEngine(null);
  assert.equal(e.snapshot().status, 'unsupported');
  assert.equal(e.speak(req('a')), false);
});
test('SpeechEngine: đặt volume tối đa và kẹp tốc độ trong khoảng Web Speech hỗ trợ', async () => {
  const { engine, synth } = makeEngine();
  await engine.init();
  engine.speak(req('A', 9));
  assert.equal(synth.spoken[0]!.volume, 1);
  assert.equal(synth.spoken[0]!.rate, 2);
  assert.ok(synth.resumes >= 1);
});
test('SpeechEngine: câu mới thay câu đang đọc; sự kiện muộn của câu cũ bị bỏ qua', async () => {
  const { engine, synth, events } = makeEngine();
  await engine.init();
  engine.speak(req('A'));
  const a = synth.spoken[0]!;
  a.onstart?.();
  const cancelsBefore = synth.cancels;
  engine.speak(req('B'));
  assert.equal(synth.cancels, cancelsBefore + 1);
  synth.spoken[1]!.onstart?.();
  a.onend?.(); // sự kiện muộn của A
  assert.equal(engine.speaking, true);
  assert.deepEqual(events.filter((e) => e.kind === 'end'), []);
});
test('SpeechEngine: báo độ trễ khởi động và thời lượng đọc thật', async () => {
  const { engine, synth, events, advance } = makeEngine();
  await engine.init();
  engine.speak(req('A'));
  advance(220);
  synth.spoken[0]!.onstart?.();
  advance(1800);
  synth.spoken[0]!.onend?.();
  assert.deepEqual(events, [
    { kind: 'start', id: 'A', latencyMs: 220 },
    { kind: 'end', id: 'A', durationMs: 1800 },
  ]);
  assert.equal(engine.busy, false);
  assert.equal(engine.speaking, false);
});
test('SpeechEngine: lỗi canceled bị bỏ qua; lỗi not-allowed được ghi nhận và báo abort', async () => {
  const { engine, synth, events } = makeEngine();
  await engine.init();
  engine.speak(req('A'));
  synth.spoken[0]!.onerror?.({ error: 'not-allowed' });
  assert.equal(engine.snapshot().lastError, 'not-allowed');
  assert.equal(engine.snapshot().needsActivation, true);
  assert.deepEqual(events.at(-1), { kind: 'abort', id: 'A', reason: 'not-allowed' });
  engine.speak(req('B'));
  synth.spoken[1]!.onstart?.();
  assert.equal(engine.snapshot().lastError, null);
  synth.spoken[1]!.onerror?.({ error: 'canceled' });
  assert.equal(engine.snapshot().lastError, null);
});
test('SpeechEngine: utterance không bắt đầu thì watchdog báo abort để driver đọc tiếp', async () => {
  const { engine, synth, timers, events } = makeEngine();
  await engine.init();
  engine.speak(req('A'));
  timers.find((t) => t.live && t.ms === 4000)!.fn();
  assert.match(engine.snapshot().lastError ?? '', /không bắt đầu/);
  assert.deepEqual(events.at(-1), { kind: 'abort', id: 'A', reason: 'start-timeout' });
  assert.equal(engine.busy, false);
  synth.spoken[0]!.onend?.(); // sự kiện muộn bị bỏ qua
  assert.equal(events.length, 1);
});
test('SpeechEngine: Chrome không bao giờ phát onend thì quá hạn vẫn coi là xong, không kẹt', async () => {
  const { engine, synth, timers, events, advance } = makeEngine();
  await engine.init();
  engine.speak(req('A'));
  synth.spoken[0]!.onstart?.();
  advance(30000);
  timers.find((t) => t.live && t.ms === 30000)!.fn();
  assert.equal(events.at(-1)?.kind, 'end');
  assert.equal(engine.busy, false);
});
test('SpeechEngine.cancel: ngừng đọc, bỏ qua sự kiện muộn', async () => {
  const { engine, synth, events } = makeEngine();
  await engine.init();
  engine.speak(req('A'));
  synth.spoken[0]!.onstart?.();
  engine.cancel();
  assert.equal(engine.speaking, false);
  assert.equal(engine.busy, false);
  synth.spoken[0]!.onend?.();
  assert.deepEqual(events.filter((e) => e.kind === 'end'), []);
});

// ---------- VolumeDucker ----------
class FakeMedia extends EventTarget implements MediaLike {
  private v: number;
  constructor(v: number) { super(); this.v = v; }
  get volume() { return this.v; }
  set volume(x: number) { this.v = x; this.dispatchEvent(new Event('volumechange')); }
  userSets(x: number) { this.v = x; this.dispatchEvent(new Event('volumechange')); }
}
function manualTimers() {
  const list: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => { list.push({ fn, ms, live: true }); return list.length - 1; },
    clearTimeout: (h) => { const e = list[h as number]; if (e) e.live = false; },
  };
  const fireAll = () => { for (const e of list.slice()) if (e.live) { e.live = false; e.fn(); } };
  return { timers, list, fireAll };
}
test('VolumeDucker: hạ theo tỷ lệ âm lượng gốc rồi trả đúng mức cũ', () => {
  const m = new FakeMedia(0.8);
  const d = new VolumeDucker(m, { rampMs: 0 });
  d.duck(0.25);
  assert.ok(Math.abs(m.volume - 0.2) < 1e-9);
  d.release(0);
  assert.ok(Math.abs(m.volume - 0.8) < 1e-9);
});
test('VolumeDucker: có độ trễ trước khi trả; duck lại trước đó thì không bị lên xuống', () => {
  const m = new FakeMedia(1);
  const t = manualTimers();
  const d = new VolumeDucker(m, { rampMs: 0, timers: t.timers });
  d.duck(0.25);
  d.release(300);
  assert.equal(m.volume, 0.25);
  d.duck(0.25); // câu kế tiếp bắt đầu
  t.fireAll(); // đồng hồ cũ đã bị hủy
  assert.equal(m.volume, 0.25);
  d.release(300);
  t.fireAll();
  assert.equal(m.volume, 1);
});
test('VolumeDucker: người dùng tự chỉnh âm lượng khi đang hạ thì không bị ghi đè', () => {
  const m = new FakeMedia(1);
  const d = new VolumeDucker(m, { rampMs: 0 });
  d.duck(0.25);
  m.userSets(0.6);
  d.duck(0.25); // câu tiếp theo trong cùng phiên hạ
  assert.equal(m.volume, 0.6);
  d.restoreNow();
  assert.equal(m.volume, 0.6);
  d.duck(0.5); // phiên mới lấy 0.6 làm mức gốc
  assert.ok(Math.abs(m.volume - 0.3) < 1e-9);
  d.restoreNow();
  assert.ok(Math.abs(m.volume - 0.6) < 1e-9);
});
test('VolumeDucker: restoreNow khi chưa hạ thì không làm gì; dispose trả lại âm lượng', () => {
  const m = new FakeMedia(0.7);
  const d = new VolumeDucker(m, { rampMs: 0 });
  d.restoreNow();
  assert.equal(m.volume, 0.7);
  d.duck(0.1);
  d.dispose();
  assert.ok(Math.abs(m.volume - 0.7) < 1e-9);
});
test('VolumeDucker: chuyển mượt theo từng bước và kết thúc đúng mức đích', () => {
  const m = new FakeMedia(1);
  const t = manualTimers();
  const d = new VolumeDucker(m, { rampMs: 150, timers: t.timers });
  d.duck(0.25);
  assert.ok(m.volume < 1 && m.volume > 0.25); // đang giữa chừng
  for (let i = 0; i < 10; i++) t.fireAll();
  assert.ok(Math.abs(m.volume - 0.25) < 1e-9);
});
test('VolumeDucker: hạ lại khi đang trả âm lượng thì lấy mức gốc, không lấy giá trị dở dang', () => {
  const m = new FakeMedia(1);
  const t = manualTimers();
  const d = new VolumeDucker(m, { rampMs: 150, timers: t.timers });
  d.duck(0.25);
  for (let i = 0; i < 10; i++) t.fireAll();
  d.restoreNow(); // bắt đầu trả, mới một bước
  assert.ok(m.volume > 0.25 && m.volume < 1);
  d.duck(0.25);
  for (let i = 0; i < 10; i++) t.fireAll();
  assert.ok(Math.abs(m.volume - 0.25) < 1e-9); // 0.25 * 1, không phải 0.25 * giá trị dở dang
  d.restoreNow();
  for (let i = 0; i < 10; i++) t.fireAll();
  assert.ok(Math.abs(m.volume - 1) < 1e-9);
});

// ---------- pacing ----------
test('countSpeechUnits: đếm từ; số dài được tính nhiều hơn vì đọc thành chữ', () => {
  assert.equal(countSpeechUnits('Xin chào các bạn'), 4);
  assert.equal(countSpeechUnits(''), 0);
  assert.ok(countSpeechUnits('năm 2024') > 2);
  assert.equal(countSpeechUnits('có 5 người'), 3);
});
test('PaceModel: tự hiệu chỉnh theo tốc độ đọc thật của giọng, bỏ qua câu quá ngắn', () => {
  const m = new PaceModel();
  const before = m.unitsPerSecond;
  m.recordUtterance(2, 1, 1000); // quá ngắn: bỏ qua
  assert.equal(m.unitsPerSecond, before);
  m.recordUtterance(10, 1, 5000); // 2 từ/giây -> giọng chậm hơn mặc định
  assert.ok(m.unitsPerSecond < before);
  for (let i = 0; i < 12; i++) m.recordUtterance(10, 1, 5000);
  assert.ok(Math.abs(m.unitsPerSecond - 2) < 0.1);
});
test('PaceModel: chuẩn hóa theo tốc độ khi đo (đọc 2x trong 2.5s = giọng 2 từ/giây ở 1x)', () => {
  const m = new PaceModel();
  for (let i = 0; i < 12; i++) m.recordUtterance(10, 2, 2500);
  assert.ok(Math.abs(m.unitsPerSecond - 2) < 0.1);
});
test('PaceModel: độ trễ khởi động được kẹp trong khoảng hợp lý và bỏ giá trị vô lý', () => {
  const m = new PaceModel();
  for (let i = 0; i < 6; i++) m.recordLatency(2500);
  assert.ok(m.startLatencySeconds <= 0.6);
  m.recordLatency(99999);
  assert.ok(m.startLatencySeconds <= 0.6);
});
test('planRate: thừa thời gian thì đọc tự nhiên 1.0x, không chậm hơn', () => {
  const r = planRate({ model: new PaceModel(), units: 4, availableSeconds: 10, previousRate: 1, ceiling: RATE_SOFT });
  assert.equal(r.rate, 1);
  assert.equal(r.fits, true);
});
test('planRate: thiếu thời gian thì tăng tốc vừa đủ, và không vượt trần', () => {
  const m = new PaceModel(); // 3.6 từ/giây
  const a = planRate({ model: m, units: 9, availableSeconds: 1.8, previousRate: 1, ceiling: RATE_SOFT }); // cần 1.39x
  assert.ok(a.rate >= 1.35 && a.rate <= 1.45 && a.fits);
  const b = planRate({ model: m, units: 30, availableSeconds: 2, previousRate: 1, ceiling: RATE_SOFT });
  assert.equal(b.rate, RATE_SOFT);
  assert.equal(b.fits, false);
  const c = planRate({ model: m, units: 30, availableSeconds: 2, previousRate: 1, ceiling: RATE_HARD });
  assert.equal(c.rate, RATE_HARD);
});
test('planRate: giảm tốc từ từ giữa các câu để nghe không bị giật', () => {
  const r = planRate({ model: new PaceModel(), units: 4, availableSeconds: 10, previousRate: 1.8, ceiling: RATE_HARD });
  assert.ok(r.rate >= 1.65 && r.rate <= 1.7);
});

// ---------- SpeechDriver ----------
const seg = (start: number, end: number): DriverSegment => ({ startTime: start, endTime: end });

function makeDriver(opts: {
  segs?: DriverSegment[];
  tr?: Record<number, string | null>;
  settings?: Partial<UserSettings>;
} = {}) {
  const segs = opts.segs ?? [seg(0, 3), seg(3, 6), seg(6, 9), seg(9, 12)];
  const tr: Record<number, string | null> = { 0: 'Câu không', 1: 'Câu một', 2: 'Câu hai', 3: 'Câu ba', ...opts.tr };
  const calls: Array<{ id: string; text: string; rate: number }> = [];
  const log: string[] = [];
  let settings: UserSettings = { ...DEFAULT_SETTINGS, speechEnabled: true, ...opts.settings };
  const speech = {
    busy: false,
    voiceName: 'An' as string | null,
    speak(r: { id: string; text: string; rate: number }) { calls.push(r); log.push(`speak:${r.text}`); this.busy = true; return true; },
    cancel() { log.push('cancel'); this.busy = false; },
  };
  const driver = new SpeechDriver({
    speech,
    getDucker: () => ({
      duck: (l) => { log.push(`duck:${l}`); },
      release: (ms) => { log.push(`release:${ms}`); },
      restoreNow: () => { log.push('restore'); },
    }),
    getSegments: () => segs,
    getTranslation: (i) => (i in tr ? tr[i]! : null),
    getSettings: () => settings,
  });
  /** Giả lập engine đọc xong câu đang đọc sau durationMs. */
  const finish = (durationMs = 1500) => {
    const last = calls.at(-1)!;
    speech.busy = false;
    driver.onEngineEvent({ kind: 'end', id: last.id, durationMs });
  };
  return { driver, calls, log, speech, tr, segs, finish, set: (s: Partial<UserSettings>) => { settings = { ...settings, ...s }; } };
}

test('SpeechDriver: không đọc trước khi đoạn đến hạn; đến hạn thì đọc đúng một lần', () => {
  const h = makeDriver({ segs: [seg(5, 8), seg(8, 11)] });
  h.driver.onPlay();
  h.driver.onTime(1, 1);
  assert.equal(h.calls.length, 0);
  h.driver.onTime(5, 1);
  h.driver.onTime(5.1, 1);
  h.driver.onTime(5.2, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.text, 'Câu không');
});
test('SpeechDriver: bắt đầu sớm một chút (đúng độ trễ khởi động) để tiếng vang lên đúng lúc', () => {
  const h = makeDriver({ segs: [seg(5, 8), seg(8, 11)] });
  h.driver.onPlay();
  h.driver.onTime(4.7, 1); // mặc định trễ khởi động 0.25s -> 4.75 mới tới hạn
  assert.equal(h.calls.length, 0);
  h.driver.onTime(4.8, 1);
  assert.equal(h.calls.length, 1);
});
test('SpeechDriver: không BAO GIỜ ngắt câu đang đọc, dù video đã sang đoạn mới', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  h.driver.onTime(3.5, 1);
  h.driver.onTime(7, 1);
  assert.equal(h.calls.length, 1);
  assert.ok(!h.log.includes('cancel'));
  h.finish();
  h.driver.onTime(7.1, 1);
  assert.equal(h.calls.length, 2);
});
test('SpeechDriver: hạ âm lượng video TRƯỚC khi đọc để không nuốt âm đầu', () => {
  const h = makeDriver({ settings: { duckLevel: 0.2 } });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  assert.deepEqual(h.log.slice(0, 2), ['duck:0.2', 'speak:Câu không']);
});
test('SpeechDriver: trả âm lượng sau độ trễ khi ngừng đọc; tắt đọc thì không hạ', () => {
  const on = makeDriver({ settings: { duckLevel: 0.3 } });
  on.driver.onSpeakingChanged(true);
  on.driver.onSpeakingChanged(false);
  assert.deepEqual(on.log, ['duck:0.3', `release:${RELEASE_DELAY_MS}`]);
  const off = makeDriver({ settings: { speechEnabled: false } });
  off.driver.onSpeakingChanged(true);
  assert.deepEqual(off.log, [`release:${RELEASE_DELAY_MS}`]);
});
test('SpeechDriver: không đọc khi tắt, đang dừng, hoặc đang quảng cáo', () => {
  const off = makeDriver({ settings: { speechEnabled: false } });
  off.driver.onPlay(); off.driver.onTime(0, 1);
  assert.equal(off.calls.length, 0);

  const paused = makeDriver();
  paused.driver.onTime(0, 1);
  assert.equal(paused.calls.length, 0);

  const ad = makeDriver();
  ad.driver.onPlay(); ad.driver.onAd(true); ad.driver.onTime(0, 1);
  assert.equal(ad.calls.length, 0);
  ad.driver.onAd(false);
  assert.equal(ad.calls.length, 1);
});
test('SpeechDriver: bản dịch về muộn thì đọc khi đoạn vẫn còn hiệu lực', () => {
  const h = makeDriver({ tr: { 0: null } });
  h.driver.onPlay();
  h.driver.onTime(0.5, 1);
  assert.equal(h.calls.length, 0);
  h.tr[0] = 'Đã dịch xong';
  h.driver.onTranslationsChanged();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.text, 'Đã dịch xong');
});
test('SpeechDriver: đoạn chỉ có nhãn âm thanh được bỏ qua lặng lẽ, không tính là bỏ sót', () => {
  const h = makeDriver({ tr: { 0: '[âm nhạc]' } });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  assert.equal(h.calls.length, 0);
  h.driver.onTime(3, 1);
  assert.equal(h.calls[0]!.text, 'Câu một');
  assert.equal(h.driver.snapshot().skipped, 0);
});
test('SpeechDriver: câu ngắn bỏ dấu câu, câu dài giữ dấu câu trước khi đọc', () => {
  const h = makeDriver({ tr: { 0: 'Xin chào, các bạn. Hôm nay thế nào?' } });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  assert.equal(h.calls[0]!.text, 'Xin chào các bạn Hôm nay thế nào'); // cả hai câu đều ngắn nên đọc liền
  const h2 = makeDriver({ tr: { 0: 'Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị, đó là âm nhạc.' } });
  h2.driver.onPlay();
  h2.driver.onTime(0, 1);
  assert.equal(h2.calls[0]!.text, 'Hôm nay chúng ta sẽ nói về một chủ đề rất thú vị, đó là âm nhạc.');
});
test('SpeechDriver: ngưỡng câu ngắn lấy từ cài đặt', () => {
  const h = makeDriver({ tr: { 0: 'Xin chào các bạn.' }, settings: { shortSentenceWords: 3 } });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  assert.equal(h.calls[0]!.text, 'Xin chào các bạn.');
});
test('SpeechDriver: pause dừng đọc và trả âm lượng; resume đọc lại câu đang dở từ đầu', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onTime(0.2, 1);
  h.driver.onPause();
  assert.deepEqual(h.log.slice(-2), ['cancel', 'restore']);
  h.driver.onPlay();
  h.driver.onTime(0.6, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.text, 'Câu không');
});
test('SpeechDriver: tua hủy giọng cũ và không đọc trong lúc đang tua', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  h.driver.onSeeking();
  assert.ok(h.log.includes('cancel'));
  h.driver.onTime(7, 1);
  assert.equal(h.calls.length, 1);
  h.driver.onSeeked();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1]!.text, 'Câu hai');
});
test('SpeechDriver: tua vào cuối một đoạn thì bỏ đoạn đó, đọc đoạn kế khi tới hạn', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onSeeking();
  h.driver.onTime(2.5, 1); // còn 0.5s là hết đoạn 0
  h.driver.onSeeked();
  assert.equal(h.calls.length, 0);
  h.driver.onTime(2.8, 1);
  assert.equal(h.calls.at(-1)!.text, 'Câu một');
});
test('SpeechDriver: thời gian video đột ngột lùi (không có sự kiện tua) thì tự định vị lại', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onTime(7, 1);
  assert.equal(h.calls[0]!.text, 'Câu hai');
  h.driver.onTime(0.5, 1);
  assert.ok(h.log.includes('cancel'));
  assert.equal(h.calls.at(-1)!.text, 'Câu không');
});
test('SpeechDriver: tắt đọc giữa chừng thì dừng và trả âm lượng', () => {
  const h = makeDriver();
  h.driver.onPlay(); h.driver.onTime(0, 1);
  h.set({ speechEnabled: false });
  h.driver.onSettingsChanged();
  assert.deepEqual(h.log.slice(-2), ['cancel', 'restore']);
});
test('SpeechDriver: đổi cài đặt giữa lúc đang đọc thì đọc xong câu rồi đọc tiếp câu sau, không đọc lại câu vừa đọc', () => {
  for (const patch of [{ maxRate: 1.2 }, { shortSentenceWords: 8 }, { duckLevel: 0.3 }, { voiceName: 'Khác' }]) {
    const h = makeDriver({ segs: [seg(0, 6), seg(6, 12)], tr: { 0: 'Câu này đang được đọc dở', 1: 'Câu kế tiếp' } });
    h.driver.onPlay(); h.driver.onTime(0, 1);
    assert.equal(h.calls.length, 1);
    h.set(patch);
    h.driver.onSettingsChanged();
    h.driver.onTime(2, 1);
    assert.equal(h.calls.length, 1, 'không được đọc chồng lên câu đang đọc');
    assert.ok(!h.log.includes('cancel'));
    h.finish(2000);
    h.driver.onTime(2.5, 1);
    assert.equal(h.calls.length, 1, `câu đầu bị đọc lại sau khi đổi ${JSON.stringify(patch)}`);
    h.driver.onTime(6, 1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1]!.text, 'Câu kế tiếp');
  }
});
test('SpeechDriver: câu ngắn đọc tự nhiên 1.0x; câu dài so với thời lượng đoạn thì tự tăng tốc', () => {
  const short = makeDriver({ segs: [seg(0, 4), seg(4, 8)], tr: { 0: 'Xin chào' } });
  short.driver.onPlay(); short.driver.onTime(0, 1);
  assert.equal(short.calls[0]!.rate, 1);

  const long = makeDriver({ segs: [seg(0, 2), seg(2, 4)], tr: { 0: 'một hai ba bốn năm sáu bảy tám chín mười' } });
  long.driver.onPlay(); long.driver.onTime(0, 1);
  assert.ok(long.calls[0]!.rate > 1.2, `rate=${long.calls[0]!.rate}`); // 10 từ trong ~1.7s
  assert.ok(long.calls[0]!.rate <= RATE_SOFT);
});
test('SpeechDriver: tốc độ đọc tối đa lấy từ cài đặt', () => {
  const text = 'một hai ba bốn năm sáu bảy tám chín mười';
  const fast = makeDriver({ segs: [seg(0, 2), seg(2, 4)], tr: { 0: text }, settings: { maxRate: 1.7 } });
  fast.driver.onPlay(); fast.driver.onTime(0, 1);
  const slow = makeDriver({ segs: [seg(0, 2), seg(2, 4)], tr: { 0: text }, settings: { maxRate: 1.1 } });
  slow.driver.onPlay(); slow.driver.onTime(0, 1);
  assert.ok(slow.calls[0]!.rate <= 1.1, `rate=${slow.calls[0]!.rate}`);
  assert.ok(fast.calls[0]!.rate > slow.calls[0]!.rate);
});
test('SpeechDriver: tốc độ phát của video cao hơn thì giọng đọc tự nhanh theo', () => {
  const text = { 0: 'một hai ba bốn năm sáu bảy tám' };
  const normal = makeDriver({ segs: [seg(0, 4), seg(4, 8)], tr: text });
  normal.driver.onPlay(); normal.driver.onTime(0, 1);
  const fast = makeDriver({ segs: [seg(0, 4), seg(4, 8)], tr: text });
  fast.driver.onPlay(); fast.driver.onTime(0, 2);
  assert.equal(normal.calls[0]!.rate, 1);
  assert.ok(fast.calls[0]!.rate > normal.calls[0]!.rate, `fast=${fast.calls[0]!.rate}`);
});
test('SpeechDriver: tự đo tốc độ đọc thật của giọng và dùng cho các câu sau', () => {
  const h = makeDriver({ tr: { 0: 'một hai ba bốn năm sáu bảy tám chín mười' } });
  const before = h.driver.snapshot().unitsPerSecond;
  h.driver.onPlay(); h.driver.onTime(0, 1);
  h.finish(5000); // 10 từ mất 5 giây ở 1.0x -> giọng chậm hơn ước lượng ban đầu
  assert.ok(h.driver.snapshot().unitsPerSecond < before);
});
test('SpeechDriver: đổi giọng thì bỏ số liệu đo của giọng cũ', () => {
  const h = makeDriver({ tr: { 0: 'một hai ba bốn năm sáu bảy tám chín mười' } });
  h.driver.onPlay(); h.driver.onTime(0, 1);
  h.finish(5000);
  const slow = h.driver.snapshot().unitsPerSecond;
  h.speech.voiceName = 'Giọng khác';
  h.driver.onTime(3.1, 1);
  assert.ok(h.driver.snapshot().unitsPerSecond > slow);
});

function denseSegments(n: number): { segs: DriverSegment[]; tr: Record<number, string> } {
  const segs: DriverSegment[] = [];
  const tr: Record<number, string> = {};
  for (let i = 0; i < n; i++) {
    segs.push(seg(i, i + 1));
    tr[i] = `đoạn ${i} nói gì đó`;
  }
  return { segs, tr };
}
test('SpeechDriver: khi trễ, tự chuyển sang bắt kịp: gộp các đoạn đến hạn thành một câu và tăng tốc', () => {
  const { segs, tr } = denseSegments(10);
  const h = makeDriver({ segs, tr });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  assert.equal(h.calls[0]!.text, 'đoạn không nói gì đó');
  h.driver.onTime(3.2, 1); // câu đầu kéo dài tới 3.2s trong khi nó chỉ có 1s
  h.finish(3200);
  h.driver.onTime(3.25, 1);
  const snap = h.driver.snapshot();
  assert.equal(snap.mode, 'catchup');
  const merged = h.calls[1]!;
  assert.match(merged.text, /đoạn hai/);
  assert.match(merged.text, /đoạn ba/);
  assert.ok(merged.rate > 1.3);
  assert.ok(merged.rate <= RATE_HARD);
  assert.ok(!h.log.includes('cancel'));
});
test('SpeechDriver: trễ quá nhiều thì bỏ NGUYÊN các đoạn đã quá cũ, không bao giờ cắt nửa câu', () => {
  const { segs, tr } = denseSegments(30);
  const h = makeDriver({ segs, tr });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  for (let t = 1; t <= 12; t++) h.driver.onTime(t, 1); // đọc dở câu đầu trong khi video đã trôi 12s
  h.finish(12000);
  h.driver.onTime(12.1, 1);
  const snap = h.driver.snapshot();
  assert.ok(snap.skipped >= 5, `skipped=${snap.skipped}`);
  assert.ok(!/đoạn 1 /.test(h.calls[1]!.text));
  assert.ok(!h.log.includes('cancel'));
});
test('SpeechDriver: hết trễ thì tự quay về chế độ tự nhiên', () => {
  const { segs, tr } = denseSegments(40);
  const h = makeDriver({ segs, tr });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  h.driver.onTime(5, 1);
  h.finish(5000);
  h.driver.onTime(5.1, 1);
  assert.equal(h.driver.snapshot().mode, 'catchup');
  // Đọc kịp: mỗi lần xong câu thì video chỉ vừa tới đoạn kế tiếp
  let t = 5.1;
  for (let i = 0; i < 12; i++) {
    t += 1.2;
    h.finish(300);
    h.driver.onTime(t, 1);
    if (h.driver.snapshot().mode === 'natural') break;
  }
  assert.equal(h.driver.snapshot().mode, 'natural');
});
test('SpeechDriver: bản dịch chưa về mà đoạn sau đã tới hạn thì không chờ mãi', () => {
  const { segs, tr } = denseSegments(10);
  tr[0] = null as unknown as string;
  const h = makeDriver({ segs, tr });
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  assert.equal(h.calls.length, 0);
  h.driver.onTime(2.2, 1);
  assert.equal(h.calls.length, 1);
  assert.ok(!/đoạn 0 /.test(h.calls[0]!.text));
});
test('SpeechDriver: sau quảng cáo thì định vị lại theo thời gian hiện tại', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  h.driver.onAd(true);
  assert.ok(h.log.includes('cancel'));
  h.driver.onAd(false);
  h.driver.onTime(7, 1);
  assert.equal(h.calls.at(-1)!.text, 'Câu hai');
});
test('SpeechDriver: sự kiện của câu cũ (id không khớp) không làm hỏng trạng thái', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  h.driver.onEngineEvent({ kind: 'end', id: 'khac', durationMs: 100 });
  h.driver.onTime(3.5, 1);
  assert.equal(h.calls.length, 1); // vẫn đang đọc câu đầu, không đọc chồng
});
test('SpeechDriver: engine báo lỗi thì đọc tiếp đoạn sau thay vì kẹt', () => {
  const h = makeDriver();
  h.driver.onPlay();
  h.driver.onTime(0, 1);
  h.speech.busy = false;
  h.driver.onEngineEvent({ kind: 'abort', id: h.calls[0]!.id, reason: 'start-timeout' });
  h.driver.onTime(3.1, 1);
  assert.equal(h.calls.at(-1)!.text, 'Câu một');
});

// ---------- settings ----------
test('sanitizeSettings: giá trị hỏng về mặc định, giá trị ngoài khoảng bị chặn, khóa cũ bị bỏ qua', () => {
  assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
  const s = sanitizeSettings({ duckLevel: -3, voiceName: 5, speechEnabled: 'yes', speechRate: 2, speechMode: 'full' });
  assert.equal(s.duckLevel, 0);
  assert.equal(s.voiceName, null);
  assert.equal(s.speechEnabled, DEFAULT_SETTINGS.speechEnabled);
  assert.ok(!('speechRate' in s));
  assert.equal(sanitizeSettings({ duckLevel: 7 }).duckLevel, 1);
  assert.equal(sanitizeSettings({ speechEnabled: false }).speechEnabled, false);
});
