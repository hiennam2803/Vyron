import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsDangling, endsSentence, mergeIntoSentences } from '../src/content/sentence-merger.ts';
import type { TranscriptSegment } from '../src/shared/types.ts';

const seg = (i: number, start: number, end: number, text: string): TranscriptSegment => ({
  id: `s${i}`, startTime: start, endTime: end, rawEndTime: end, originalText: text, sourceLanguage: 'en',
});

test('gộp hai mảnh bị cắt giữa câu thành một câu, giữ timestamp đầu/cuối', () => {
  const r = mergeIntoSentences(
    [seg(0, 0, 1.5, 'so where should we'), seg(1, 1.5, 3, 'start from?'), seg(2, 3.2, 5, 'Good question.')],
    'en',
  );
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0]!.originalText, 'so where should we start from?');
  assert.equal(r.segments[0]!.startTime, 0);
  assert.equal(r.segments[0]!.endTime, 3);
  assert.equal(r.segments[1]!.originalText, 'Good question.');
  assert.equal(r.sourceCount, 3);
  assert.equal(r.mergedGroups, 1);
  assert.deepEqual(r.segments.map((s) => s.id), ['s0', 's1']);
});

test('không gộp qua dấu kết câu', () => {
  const r = mergeIntoSentences([seg(0, 0, 1, 'Hello there.'), seg(1, 1, 2, 'How are you')], 'en');
  assert.equal(r.segments.length, 2);
});

test('không gộp khi có khoảng lặng dài (đổi ý, đổi cảnh)', () => {
  const r = mergeIntoSentences([seg(0, 0, 1, 'well I think'), seg(1, 3, 4, 'anyway')], 'en');
  assert.equal(r.segments.length, 2);
});

test('mảnh kết thúc bằng từ nối (the, and...) chịu được khoảng lặng dài hơn', () => {
  const r = mergeIntoSentences([seg(0, 0, 1, 'we went to the'), seg(1, 2.2, 3, 'market')], 'en');
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0]!.originalText, 'we went to the market');
});

test('không gộp nhãn âm thanh và đổi người nói', () => {
  const r = mergeIntoSentences(
    [seg(0, 0, 1, 'and so on'), seg(1, 1, 2, '[Music]'), seg(2, 2, 3, 'next one'), seg(3, 3, 4, '>> yes sir')],
    'en',
  );
  assert.deepEqual(r.segments.map((s) => s.originalText), ['and so on', '[Music]', 'next one', '>> yes sir']);
});

test('giới hạn số từ và thời lượng để không đọc trễ video', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const r = mergeIntoSentences([seg(0, 0, 4, words(15)), seg(1, 4, 8, words(15))], 'en');
  assert.equal(r.segments.length, 2); // 30 từ > maxWords
  const t = mergeIntoSentences([seg(0, 0, 6, 'a b c'), seg(1, 6, 12, 'd e f')], 'en');
  assert.equal(t.segments.length, 2); // 12 giây > maxDuration
});

test('viết tắt và tên riêng không bị coi là hết câu', () => {
  assert.equal(endsSentence('I talked to Dr.'), false);
  assert.equal(endsSentence('by J.'), false);
  assert.equal(endsSentence('so do I.'), true);
  assert.equal(endsSentence('really?'), true);
  assert.equal(endsSentence('Wait…'), true);
  assert.equal(endsSentence('and then'), false);
});

test('endsDangling theo ngôn ngữ', () => {
  assert.equal(endsDangling('we went to the', 'en'), true);
  assert.equal(endsDangling('we went home', 'en'), false);
  assert.equal(endsDangling('chúng ta và', 'vi'), true);
  assert.equal(endsDangling('whatever the', 'xx'), false);
});

test('đầu vào rỗng hoặc một mảnh', () => {
  assert.equal(mergeIntoSentences([], 'en').segments.length, 0);
  const r = mergeIntoSentences([seg(0, 0, 1, 'hi')], 'en');
  assert.equal(r.segments.length, 1);
  assert.equal(r.mergedGroups, 0);
});

test('không làm thay đổi mảng đầu vào', () => {
  const input = [seg(0, 0, 1, 'one two'), seg(1, 1, 2, 'three')];
  mergeIntoSentences(input, 'en');
  assert.equal(input[0]!.originalText, 'one two');
  assert.equal(input[0]!.endTime, 1);
});
