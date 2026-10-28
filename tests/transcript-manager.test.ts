import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSegmentIndex, parseJson3, pickDefaultTrackIndex } from '../src/content/transcript-manager.ts';
import { getVideoIdFromUrl } from '../src/shared/youtube-url.ts';
import type { TranscriptSegment } from '../src/shared/types.ts';

const seg = (start: number, end: number, text = 't'): TranscriptSegment => ({
  id: `s${start}`, startTime: start, endTime: end, rawEndTime: end, originalText: text, sourceLanguage: 'en',
});

test('parseJson3: ghép seg, gộp xuống dòng, đổi ms -> giây', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Hello' }, { utf8: ' world\n' }, { utf8: 'again' }] },
      { tStartMs: 5000, dDurationMs: 2500, segs: [{ utf8: 'Second' }] },
    ],
  });
  const { segments, stats } = parseJson3(body, 'en');
  assert.equal(segments.length, 2);
  assert.equal(segments[0]!.originalText, 'Hello world again');
  assert.equal(segments[0]!.startTime, 0);
  assert.equal(segments[0]!.endTime, 5);
  assert.equal(segments[1]!.endTime, 7.5);
  assert.equal(stats.overlapCount, 0);
  assert.equal(stats.lastEnd, 7.5);
});

test('parseJson3: bỏ event không có segs hoặc chỉ có khoảng trắng', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 1000 },
      { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'ok' }] },
    ],
  });
  assert.equal(parseJson3(body, 'en').segments.length, 1);
});

test('parseJson3: loại đoạn trùng, đếm chồng lấn, ước lượng endTime thiếu duration', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'a' }] },
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'a' }] },
      { tStartMs: 2000, dDurationMs: 4000, segs: [{ utf8: 'b' }] },
      { tStartMs: 9000, segs: [{ utf8: 'c' }] },
      { tStartMs: 12000, dDurationMs: 1000, segs: [{ utf8: 'd' }] },
    ],
  });
  const { segments, stats } = parseJson3(body, 'en');
  assert.equal(stats.duplicatesRemoved, 1);
  assert.equal(stats.overlapCount, 1); // b bắt đầu 2s < a kết thúc 4s
  assert.equal(stats.estimatedEndCount, 1);
  assert.equal(segments[2]!.endTime, 12); // c: lấy start của d
});

test('parseJson3: JSON hỏng hoặc thiếu events -> PARSE_FAILED', () => {
  assert.throws(() => parseJson3('<html>', 'en'), { code: 'PARSE_FAILED' });
  assert.throws(() => parseJson3('{}', 'en'), { code: 'PARSE_FAILED' });
});

test('findSegmentIndex: tua tới giây 2 của đoạn 0-5 phải trả đúng đoạn', () => {
  const s = [seg(0, 5), seg(5, 8), seg(10, 12)];
  assert.equal(findSegmentIndex(s, 2), 0);
});

test('findSegmentIndex: biên start gồm, end không gồm; khoảng trống = -1', () => {
  const s = [seg(0, 5), seg(5, 8), seg(10, 12)];
  assert.equal(findSegmentIndex(s, 0), 0);
  assert.equal(findSegmentIndex(s, 5), 1);
  assert.equal(findSegmentIndex(s, 8), -1);
  assert.equal(findSegmentIndex(s, 9.9), -1);
  assert.equal(findSegmentIndex(s, 10), 2);
  assert.equal(findSegmentIndex(s, 12), -1);
  assert.equal(findSegmentIndex([seg(3, 4)], 1), -1);
});

test('findSegmentIndex: danh sách rỗng, NaN, âm', () => {
  assert.equal(findSegmentIndex([], 1), -1);
  assert.equal(findSegmentIndex([seg(0, 1)], NaN), -1);
  assert.equal(findSegmentIndex([seg(0, 1)], -1), -1);
});

test('findSegmentIndex: chồng lấn chọn đoạn bắt đầu muộn nhất còn hiệu lực', () => {
  const s = [seg(0, 4), seg(2, 6)];
  assert.equal(findSegmentIndex(s, 1), 0);
  assert.equal(findSegmentIndex(s, 3), 1);
  assert.equal(findSegmentIndex(s, 5), 1);
});

test('findSegmentIndex: đoạn dài đứng trước vẫn được tìm thấy sau đoạn ngắn lồng bên trong', () => {
  const s = [seg(0, 20), seg(5, 6)];
  assert.equal(findSegmentIndex(s, 10), 0);
});

test('pickDefaultTrackIndex', () => {
  const t = (languageCode: string, kind: 'manual' | 'asr') => ({ languageCode, kind });
  assert.equal(pickDefaultTrackIndex([t('en', 'asr'), t('en', 'manual')]), 1);
  assert.equal(pickDefaultTrackIndex([t('fr', 'manual'), t('en-US', 'asr')]), 1);
  assert.equal(pickDefaultTrackIndex([t('fr', 'asr'), t('de', 'manual')]), 1);
  assert.equal(pickDefaultTrackIndex([t('fr', 'asr')]), 0);
  assert.equal(pickDefaultTrackIndex([]), -1);
});

test('getVideoIdFromUrl', () => {
  assert.equal(getVideoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
  assert.equal(getVideoIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(getVideoIdFromUrl('https://www.youtube.com/'), null);
  assert.equal(getVideoIdFromUrl('https://www.youtube.com/watch?v=short'), null);
  assert.equal(getVideoIdFromUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(getVideoIdFromUrl('not a url'), null);
});

test('parseJson3: mặc định giữ nguyên endTime chồng lấn', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'a' }] },
      { tStartMs: 2000, dDurationMs: 4000, segs: [{ utf8: 'b' }] },
    ],
  });
  const { segments, stats } = parseJson3(body, 'en');
  assert.equal(segments[0]!.endTime, 4);
  assert.equal(stats.clippedCount, 0);
});

test('parseJson3: clipOverlaps cắt endTime tại start đoạn kế, giữ rawEndTime', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'a' }] },
      { tStartMs: 2000, dDurationMs: 4000, segs: [{ utf8: 'b' }] },
      { tStartMs: 5000, dDurationMs: 4000, segs: [{ utf8: 'c' }] },
    ],
  });
  const { segments, stats } = parseJson3(body, 'en', { clipOverlaps: true });
  assert.deepEqual(segments.map((s) => s.endTime), [2, 5, 9]);
  assert.deepEqual(segments.map((s) => s.rawEndTime), [4, 6, 9]);
  assert.equal(stats.overlapCount, 2); // tính trên timestamp gốc
  assert.equal(stats.clippedCount, 2);
  assert.equal(findSegmentIndex(segments, 1.9), 0);
  assert.equal(findSegmentIndex(segments, 2), 1);
  assert.equal(findSegmentIndex(segments, 5), 2);
});

test('parseJson3: clipOverlaps không tạo đoạn dài 0 khi hai đoạn cùng start', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'a' }] },
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'b' }] },
    ],
  });
  const { segments } = parseJson3(body, 'en', { clipOverlaps: true });
  assert.ok(segments.every((s) => s.endTime > s.startTime));
});
