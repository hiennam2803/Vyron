import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationEngine } from '../src/translation/translation-engine.ts';
import type { BackendAvailability, BatchItem, TranslationBackend, TranslationCache } from '../src/translation/translation-engine.ts';
import { findAnchorIndex } from '../src/content/transcript-manager.ts';
import { makeCacheKey } from '../src/shared/cache-key.ts';
import type { TranscriptSegment } from '../src/shared/types.ts';

const MODEL = 'm1';
const segs = (texts: string[]): TranscriptSegment[] =>
  texts.map((t, i) => ({ id: `s${i}`, startTime: i * 2, endTime: i * 2 + 2, rawEndTime: i * 2 + 2, originalText: t, sourceLanguage: 'en' }));
const many = (n: number) => segs(Array.from({ length: n }, (_, i) => `sentence ${i}`));

class FakeBackend implements TranslationBackend {
  avail: BackendAvailability = 'available';
  calls: string[][] = [];
  prepareCalls = 0;
  prepareError: unknown = null;
  batchError: unknown = null;
  failTexts = new Set<string>();
  gate: Promise<void> | null = null;
  async availability() { return this.avail; }
  async prepare(_s: string, _t: string, onProgress: (p: number) => void) {
    this.prepareCalls++;
    if (this.prepareError) throw this.prepareError;
    onProgress(0.5);
  }
  async translateBatch(_s: string, _t: string, texts: string[]): Promise<BatchItem[]> {
    if (this.gate) await this.gate;
    if (this.batchError) throw this.batchError;
    this.calls.push(texts);
    return texts.map((t) => (this.failTexts.has(t) ? { ok: false as const, message: 'x' } : { ok: true as const, text: `vi:${t}` }));
  }
}
class FakeCache implements TranslationCache {
  store = new Map<string, string>();
  getError = false;
  async get(keys: string[]) {
    if (this.getError) throw new Error('idb down');
    const out: Record<string, string> = {};
    for (const k of keys) { const v = this.store.get(k); if (v !== undefined) out[k] = v; }
    return out;
  }
  async set(entries: Array<[string, string]>) { for (const [k, v] of entries) this.store.set(k, v); }
}
function make(segments: TranscriptSegment[], backend = new FakeBackend(), cache = new FakeCache(), extra = {}) {
  const engine = new TranslationEngine({
    backend, cache, segments, sourceLanguage: 'en', targetLanguage: 'vi', modelId: MODEL,
    lookahead: 10, batchSize: 4, maxAttempts: 2, sleep: async () => {}, ...extra,
  });
  return { engine, backend, cache };
}
const run = async (engine: TranslationEngine, anchor = 0) => { await engine.init(); engine.setPlayhead(anchor); await engine.whenIdle(); };

test('chỉ dịch cửa sổ lookahead quanh vị trí phát, không dịch cả video', async () => {
  const { engine } = make(many(100));
  await run(engine, 0);
  assert.equal(engine.snapshot().translatedCount, 10);
  assert.equal(engine.getTranslation(9), 'vi:sentence 9');
  assert.equal(engine.getTranslation(10), null);
});

test('tua: cửa sổ dịch dời theo vị trí mới, chia lô tối đa batchSize', async () => {
  const { engine, backend } = make(many(100));
  await run(engine, 0);
  engine.setPlayhead(50);
  await engine.whenIdle();
  assert.equal(engine.getTranslation(50), 'vi:sentence 50');
  assert.equal(engine.getTranslation(59), 'vi:sentence 59');
  assert.equal(engine.getTranslation(60), null);
  assert.equal(engine.getTranslation(30), null);
  assert.ok(backend.calls.every((c) => c.length <= 4));
});

test('không dịch trùng: cùng nội dung chỉ gọi bộ dịch một lần', async () => {
  const { engine, backend } = make(segs(['Yeah.', 'Yeah.', 'Okay.', 'Yeah.', '  Yeah. ', 'Okay.']));
  await run(engine);
  assert.equal(engine.snapshot().translatedCount, 6);
  assert.equal(engine.snapshot().backendCalls, 2);
  assert.deepEqual(backend.calls.flat().sort(), ['Okay.', 'Yeah.']);
  assert.equal(engine.getTranslation(4), 'vi:Yeah.');
});

test('cache: đoạn có sẵn trong cache không gọi bộ dịch; kết quả mới được ghi vào cache', async () => {
  const cache = new FakeCache();
  cache.store.set(makeCacheKey(MODEL, 'en', 'vi', 'sentence 1'), 'đã có sẵn');
  const { engine, backend } = make(many(3), new FakeBackend(), cache);
  await run(engine);
  assert.equal(engine.getTranslation(1), 'đã có sẵn');
  assert.ok(!backend.calls.flat().includes('sentence 1'));
  assert.equal(cache.store.get(makeCacheKey(MODEL, 'en', 'vi', 'sentence 0')), 'vi:sentence 0');
  assert.equal(engine.snapshot().backendCalls, 2);
});

test('cache khác phiên bản bộ dịch không bị dùng nhầm', async () => {
  const cache = new FakeCache();
  cache.store.set(makeCacheKey('OTHER', 'en', 'vi', 'sentence 0'), 'cũ');
  const { engine } = make(many(1), new FakeBackend(), cache);
  await run(engine);
  assert.equal(engine.getTranslation(0), 'vi:sentence 0');
});

test('cache lỗi không làm hỏng việc dịch', async () => {
  const cache = new FakeCache();
  cache.getError = true;
  const { engine } = make(many(3), new FakeBackend(), cache);
  await run(engine);
  assert.equal(engine.snapshot().translatedCount, 3);
});

test('cần tải gói ngôn ngữ: không dịch cho đến khi người dùng bấm; thiếu user activation thì giữ nguyên trạng thái', async () => {
  const backend = new FakeBackend();
  backend.avail = 'downloadable';
  const { engine } = make(many(3), backend);
  await engine.init();
  engine.setPlayhead(0);
  await engine.whenIdle();
  assert.equal(engine.snapshot().phase, 'needs-download');
  assert.equal(backend.prepareCalls, 0);
  assert.equal(backend.calls.length, 0);

  backend.prepareError = { code: 'TRANSLATOR_NEEDS_ACTIVATION', message: 'cần bấm' };
  await engine.requestDownload();
  assert.equal(engine.snapshot().phase, 'needs-download');
  assert.equal(engine.snapshot().error?.code, 'TRANSLATOR_NEEDS_ACTIVATION');

  backend.prepareError = null;
  await engine.requestDownload();
  await engine.whenIdle();
  assert.equal(engine.snapshot().phase, 'ready');
  assert.equal(engine.snapshot().translatedCount, 3);
});

test('API không có hoặc cặp ngôn ngữ không khả dụng: báo rõ, không gọi bộ dịch', async () => {
  for (const [avail, code] of [['unsupported-api', 'TRANSLATOR_UNSUPPORTED'], ['unavailable', 'TRANSLATOR_UNAVAILABLE']] as const) {
    const backend = new FakeBackend();
    backend.avail = avail;
    const { engine } = make(many(3), backend);
    await run(engine);
    const s = engine.snapshot();
    assert.equal(s.phase, 'unsupported');
    assert.equal(s.error?.code, code);
    assert.equal(backend.calls.length, 0);
  }
});

test('nguồn trùng đích: không cần dịch', async () => {
  const backend = new FakeBackend();
  const { engine } = make(many(3), backend, new FakeCache(), { sourceLanguage: 'vi' });
  await run(engine);
  assert.equal(engine.snapshot().phase, 'not-needed');
  assert.equal(backend.calls.length, 0);
});

test('dispose giữa chừng: kết quả đến muộn không ghi đè trạng thái', async () => {
  const backend = new FakeBackend();
  let release!: () => void;
  backend.gate = new Promise<void>((r) => { release = r; });
  const { engine } = make(many(5), backend);
  await engine.init();
  engine.setPlayhead(0);
  engine.dispose();
  release();
  await engine.whenIdle();
  assert.equal(engine.snapshot().translatedCount, 0);
  assert.equal(engine.getTranslation(0), null);
});

test('đoạn dịch lỗi được thử lại tối đa maxAttempts rồi bỏ; các đoạn khác vẫn xong; không lặp vô hạn', async () => {
  const backend = new FakeBackend();
  backend.failTexts.add('sentence 2');
  const { engine } = make(many(5), backend);
  await run(engine);
  const s = engine.snapshot();
  assert.equal(s.translatedCount, 4);
  assert.equal(s.failedCount, 1);
  assert.equal(engine.getTranslation(2), null);
  assert.equal(backend.calls.flat().filter((t) => t === 'sentence 2').length, 2);
});

test('bộ dịch hỏng hẳn -> phase error; retry() chạy lại sau khi sửa', async () => {
  const backend = new FakeBackend();
  backend.batchError = new Error('boom');
  const { engine } = make(many(3), backend);
  await run(engine);
  assert.equal(engine.snapshot().phase, 'error');
  assert.equal(engine.snapshot().error?.code, 'TRANSLATOR_FAILED');

  backend.batchError = null;
  await engine.retry();
  engine.setPlayhead(0);
  await engine.whenIdle();
  assert.equal(engine.snapshot().phase, 'ready');
  assert.equal(engine.snapshot().translatedCount, 3);
});

test('timestamp của đoạn không bị bộ dịch thay đổi', async () => {
  const input = many(3);
  const before = JSON.stringify(input.map((s) => [s.startTime, s.endTime, s.rawEndTime]));
  const { engine } = make(input);
  await run(engine);
  assert.equal(JSON.stringify(input.map((s) => [s.startTime, s.endTime, s.rawEndTime])), before);
});

test('findAnchorIndex: đoạn hiện tại, đoạn sắp tới khi ở khoảng trống, hết phụ đề', () => {
  const s = [
    { startTime: 0, endTime: 2 }, { startTime: 5, endTime: 7 }, { startTime: 10, endTime: 12 },
  ].map((x, i) => ({ id: `s${i}`, ...x, rawEndTime: x.endTime, originalText: 't', sourceLanguage: 'en' }));
  assert.equal(findAnchorIndex(s, 1), 0);
  assert.equal(findAnchorIndex(s, 3), 1);
  assert.equal(findAnchorIndex(s, 7), 2);
  assert.equal(findAnchorIndex(s, 13), 3);
  assert.equal(findAnchorIndex(s, NaN), 0);
});
