import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integerToWords, normalizeNumbers } from '../src/speech/numbers.ts';
import { splitByLanguage } from '../src/speech/lang-split.ts';
import { respellEnglish } from '../src/speech/respell.ts';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/shared/user-settings.ts';
import { toSpeakable } from '../src/speech/speakable.ts';
import { SpeechEngine } from '../src/speech/speech-engine.ts';
import type { SpeechDeps, UtteranceLike } from '../src/speech/speech-engine.ts';

test('integerToWords: quy tắc đọc số tiếng Việt', () => {
  const c: Array<[string, string]> = [
    ['0', 'không'], ['5', 'năm'], ['10', 'mười'], ['15', 'mười lăm'], ['21', 'hai mươi mốt'], ['25', 'hai mươi lăm'],
    ['100', 'một trăm'], ['105', 'một trăm linh năm'], ['110', 'một trăm mười'], ['1000', 'một nghìn'],
    ['10000', 'mười nghìn'], ['100000', 'một trăm nghìn'], ['2024', 'hai nghìn không trăm hai mươi bốn'],
    ['1000000', 'một triệu'], ['1005000', 'một triệu không trăm linh năm nghìn'], ['2500000000', 'hai tỷ năm trăm triệu'],
  ];
  for (const [n, w] of c) assert.equal(integerToWords(n), w, n);
});

test('normalizeNumbers: dấu nghìn, thập phân, tiền, phần trăm, giờ, ngày, đơn vị', () => {
  assert.equal(normalizeNumbers('10.000 đô'), 'mười nghìn đô');
  assert.equal(normalizeNumbers('10,000 đô'), 'mười nghìn đô');
  assert.equal(normalizeNumbers('1.234.567'), 'một triệu hai trăm ba mươi bốn nghìn năm trăm sáu mươi bảy');
  assert.equal(normalizeNumbers('2,5 lần'), 'hai phẩy năm lần');
  assert.equal(normalizeNumbers('0,05'), 'không phẩy không năm');
  assert.equal(normalizeNumbers('$10,000'), 'mười nghìn đô la');
  assert.equal(normalizeNumbers('$2M'), 'hai triệu đô la');
  assert.equal(normalizeNumbers('50%'), 'năm mươi phần trăm');
  assert.equal(normalizeNumbers('lúc 3:05'), 'lúc ba giờ không năm');
  assert.equal(normalizeNumbers('25/12/2024'), 'ngày hai mươi lăm tháng mười hai năm hai nghìn không trăm hai mươi bốn');
  assert.equal(normalizeNumbers('5 km'), 'năm ki lô mét');
  assert.equal(normalizeNumbers('10.000đ'), 'mười nghìn đồng');
  assert.equal(normalizeNumbers('2020-2024'), 'hai nghìn không trăm hai mươi đến hai nghìn không trăm hai mươi bốn');
  assert.equal(normalizeNumbers('-5'), 'âm năm');
});

test('normalizeNumbers: số điện thoại/mã đọc từng chữ số; số dính chữ giữ nguyên cho giọng Anh', () => {
  assert.equal(normalizeNumbers('0901234567'), 'không chín không một hai ba bốn năm sáu bảy');
  assert.equal(normalizeNumbers('3D và 5G'), '3D và 5G');
  assert.equal(normalizeNumbers('GPT-4'), 'GPT bốn');
});

test('splitByLanguage: từ tiếng Anh xen trong câu tiếng Việt dùng giọng Anh', () => {
  assert.deepEqual(splitByLanguage('Chúng ta dùng electric logo này'), [
    { text: 'Chúng ta dùng', lang: 'vi' },
    { text: 'electric logo', lang: 'en' },
    { text: 'này', lang: 'vi' },
  ]);
  assert.deepEqual(splitByLanguage('Anh ấy là CEO của Tesla'), [
    { text: 'Anh ấy là', lang: 'vi' },
    { text: 'C E O', lang: 'en' }, // viết tắt được đánh vần
    { text: 'của', lang: 'vi' },
    { text: 'Tesla', lang: 'en' },
  ]);
  assert.deepEqual(splitByLanguage('NASA và YouTube'), [
    { text: 'NASA', lang: 'en' },
    { text: 'và', lang: 'vi' },
    { text: 'YouTube', lang: 'en' },
  ]);
});

test('splitByLanguage: câu thuần Việt (kể cả từ không dấu hợp lệ) không bị tách', () => {
  assert.deepEqual(splitByLanguage('Nó rất tin tưởng ban đầu'), [{ text: 'Nó rất tin tưởng ban đầu', lang: 'vi' }]);
  assert.deepEqual(splitByLanguage('An to lớn'), [{ text: 'An to lớn', lang: 'vi' }]);
  assert.deepEqual(splitByLanguage(''), []);
});

test('splitByLanguage: từ chức năng ngắn đi theo cụm tiếng Anh, từ Việt không dấu ở giữa vẫn là tiếng Việt', () => {
  assert.deepEqual(splitByLanguage('Hãy làm in the box ngay'), [
    { text: 'Hãy làm', lang: 'vi' },
    { text: 'in the box', lang: 'en' },
    { text: 'ngay', lang: 'vi' },
  ]);
  assert.deepEqual(splitByLanguage('electric cho tesla'), [
    { text: 'electric', lang: 'en' },
    { text: 'cho', lang: 'vi' },
    { text: 'tesla', lang: 'en' },
  ]);
});

test('splitByLanguage: cụm chỉ gồm từ mượn quen thuộc giữ giọng Việt để khỏi đổi giọng', () => {
  assert.deepEqual(splitByLanguage('Xem video này'), [{ text: 'Xem video này', lang: 'vi' }]);
  assert.deepEqual(splitByLanguage('Xem electric video này'), [
    { text: 'Xem', lang: 'vi' },
    { text: 'electric video', lang: 'en' },
    { text: 'này', lang: 'vi' },
  ]);
});

test('toSpeakable + splitByLanguage: số xen tiếng Anh', () => {
  assert.deepEqual(splitByLanguage(toSpeakable('Tôi dùng iPhone 15 Pro')), [
    { text: 'Tôi dùng', lang: 'vi' },
    { text: 'iPhone', lang: 'en' },
    { text: 'mười lăm', lang: 'vi' },
    { text: 'Pro', lang: 'en' },
  ]);
});

// ---------- SpeechEngine với giọng Anh ----------
type V = { name: string; lang: string; localService: boolean };
function makeEngine(voices: V[]) {
  const spoken: Array<{ text: string; voice: string; lang: string }> = [];
  const queue: UtteranceLike[] = [];
  const synth = {
    speak(u: UtteranceLike) { queue.push(u); spoken.push({ text: u.text, voice: (u.voice as V).name, lang: u.lang }); },
    cancel() { queue.length = 0; },
    getVoices: () => voices,
    addEventListener() {},
  };
  const deps: SpeechDeps = {
    synth,
    createUtterance: (text) => ({ text, lang: '', voice: null, rate: 1, volume: 1, onstart: null, onend: null, onerror: null }),
    setTimeout: () => 0,
    clearTimeout: () => {},
    now: () => 0,
  };
  const engine = new SpeechEngine(deps);
  return { engine, spoken, queue };
}
const VI: V = { name: 'Viet', lang: 'vi-VN', localService: true };
const EN: V = { name: 'English', lang: 'en-US', localService: true };

test('SpeechEngine: có giọng Anh -> tách câu thành nhiều đoạn, mỗi đoạn đúng giọng; end chỉ báo sau đoạn cuối', async () => {
  const { engine, spoken, queue } = makeEngine([VI, EN]);
  await engine.init();
  engine.configure({ preferredName: null, allowNetwork: false });
  const events: string[] = [];
  engine.setListener((e) => events.push(e.kind));
  assert.equal(engine.speak({ id: 'a', text: 'Chúng ta dùng electric logo này', rate: 1 }), true);
  assert.deepEqual(spoken.map((s) => [s.text, s.voice]), [
    ['Chúng ta dùng', 'Viet'], ['electric logo', 'English'], ['này', 'Viet'],
  ]);
  queue[0]!.onstart?.();
  queue[0]!.onend?.(); // đoạn giữa chừng kết thúc: chưa được báo end
  queue[1]!.onend?.();
  assert.deepEqual(events, ['start']);
  queue[2]!.onend?.();
  assert.deepEqual(events, ['start', 'end']);
});

test('SpeechEngine: không có giọng Anh hoặc tắt tùy chọn -> đọc cả câu bằng giọng Việt như cũ', async () => {
  const a = makeEngine([VI]);
  await a.engine.init();
  a.engine.configure({ preferredName: null, allowNetwork: false });
  a.engine.speak({ id: 'a', text: 'Dùng electric logo', rate: 1 });
  assert.equal(a.spoken.length, 1);

  const b = makeEngine([VI, EN]);
  await b.engine.init();
  b.engine.configure({ preferredName: null, allowNetwork: false, englishEnabled: false });
  b.engine.speak({ id: 'a', text: 'Dùng electric logo', rate: 1 });
  assert.equal(b.spoken.length, 1);
  assert.equal(b.engine.snapshot().englishVoice, null);
});

test('SpeechEngine: lỗi ở một đoạn -> báo abort một lần', async () => {
  const { engine, queue } = makeEngine([VI, EN]);
  await engine.init();
  engine.configure({ preferredName: null, allowNetwork: false });
  const events: string[] = [];
  engine.setListener((e) => events.push(e.kind));
  engine.speak({ id: 'a', text: 'Dùng electric logo này', rate: 1 });
  queue[0]!.onerror?.({ error: 'synthesis-failed' });
  assert.deepEqual(events, ['abort']);
});

// ---------- Phiên âm từ tiếng Anh + cài đặt ----------
test('respellEnglish: thay từ thông dụng, giữ nguyên từ khác, phân biệt AI viết tắt với "ai"', () => {
  assert.equal(respellEnglish('Tôi dùng electric logo'), 'Tôi dùng i léc trích lô gô');
  assert.equal(respellEnglish('Xem trên YouTube và Google'), 'Xem trên diu túp và gu gồ');
  assert.equal(respellEnglish('Gửi email nhé'), 'Gửi i meo nhé');
  assert.equal(respellEnglish('Ai biết không? AI sẽ làm'), 'Ai biết không? ây ai sẽ làm');
  assert.equal(respellEnglish('Từ lạ như quasar giữ nguyên'), 'Từ lạ như quasar giữ nguyên');
  assert.equal(respellEnglish("it's like that"), "it's lai that"); // "it's" không bị cắt giữa chừng
  assert.equal(respellEnglish('linkedinx'), 'linkedinx'); // chỉ thay nguyên từ
});

test('SpeechEngine: bật phiên âm -> từ thông dụng đọc liền bằng giọng Việt, từ lạ vẫn dùng giọng Anh', async () => {
  const { engine, spoken } = makeEngine([VI, EN]);
  await engine.init();
  engine.configure({ preferredName: null, allowNetwork: false, respellEnabled: true });
  engine.speak({ id: 'a', text: 'Chúng ta dùng electric logo với quasar', rate: 1 });
  assert.deepEqual(spoken.map((s) => [s.text, s.voice]), [
    ['Chúng ta dùng i léc trích lô gô với', 'Viet'], ['quasar', 'English'],
  ]);
  // không có giọng Anh: vẫn phiên âm để giọng Việt đọc đúng hơn
  const b = makeEngine([VI]);
  await b.engine.init();
  b.engine.configure({ preferredName: null, allowNetwork: false, respellEnabled: true });
  b.engine.speak({ id: 'a', text: 'Dùng electric logo', rate: 1 });
  assert.deepEqual(b.spoken.map((s) => s.text), ['Dùng i léc trích lô gô']);
});

test('sanitizeSettings: shortSentenceWords kẹp 0-12 và làm tròn; maxRate kẹp 1.1-1.7 bước 0.1; readEnglish mặc định bật', () => {
  assert.equal(sanitizeSettings({}).shortSentenceWords, DEFAULT_SETTINGS.shortSentenceWords);
  assert.equal(sanitizeSettings({ shortSentenceWords: 99 }).shortSentenceWords, 12);
  assert.equal(sanitizeSettings({ shortSentenceWords: -3 }).shortSentenceWords, 0);
  assert.equal(sanitizeSettings({ shortSentenceWords: 6.6 }).shortSentenceWords, 7);
  assert.equal(sanitizeSettings({ shortSentenceWords: 'x' }).shortSentenceWords, DEFAULT_SETTINGS.shortSentenceWords);
  assert.equal(sanitizeSettings({}).maxRate, 1.7);
  assert.equal(sanitizeSettings({ maxRate: 5 }).maxRate, 1.7);
  assert.equal(sanitizeSettings({ maxRate: 0.5 }).maxRate, 1.1);
  assert.equal(sanitizeSettings({ maxRate: 1.34 }).maxRate, 1.3);
  assert.equal(sanitizeSettings({}).readEnglish, true);
  assert.equal(sanitizeSettings({ readEnglish: false }).readEnglish, false);
});

test('sanitizeSettings: giọng qua mạng bật sẵn; cài đặt cũ (chưa có phiên bản) được chuyển sang bật, sau đó tôn trọng lựa chọn', () => {
  assert.equal(sanitizeSettings({}).allowNetworkVoice, true);
  assert.equal(sanitizeSettings({ allowNetworkVoice: false }).allowNetworkVoice, true); // bản cũ: chuyển một lần
  const saved = sanitizeSettings({ allowNetworkVoice: false });
  assert.equal(sanitizeSettings({ ...saved, allowNetworkVoice: false }).allowNetworkVoice, false); // đã có phiên bản: giữ lựa chọn tắt
});
