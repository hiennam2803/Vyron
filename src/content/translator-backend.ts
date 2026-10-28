import type { TrAvailabilityResult, TrBatchResult } from '../shared/protocol.ts';
import type { TranslationBackend } from '../translation/translation-engine.ts';
import { bridgeCall } from './bridge-client.ts';

/** Backend dịch dùng Chrome Translator API, chạy qua page-bridge ở MAIN world. */
export const chromeTranslatorBackend: TranslationBackend = {
  async availability(source, target) {
    const r = await bridgeCall<TrAvailabilityResult>({ type: 'TR_AVAILABILITY', srcLang: source, tgtLang: target });
    return r.availability;
  },
  async prepare(source, target, onProgress) {
    // Tải gói ngôn ngữ có thể lâu: timeout tính từ lần nhận tiến độ gần nhất.
    await bridgeCall<unknown>({ type: 'TR_PREPARE', srcLang: source, tgtLang: target }, 60_000, onProgress);
  },
  async translateBatch(source, target, texts) {
    const r = await bridgeCall<TrBatchResult>({ type: 'TR_TRANSLATE_BATCH', srcLang: source, tgtLang: target, texts }, 60_000);
    return r.items;
  },
};
