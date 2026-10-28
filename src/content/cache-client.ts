import type { TranslationCache } from '../translation/translation-engine.ts';

async function send<T>(msg: unknown): Promise<T> {
  const res = (await chrome.runtime.sendMessage(msg)) as { ok: boolean; data?: T; error?: string } | undefined;
  if (!res?.ok) throw new Error(res?.error ?? 'service worker không phản hồi');
  return res.data as T;
}

/** Cache nằm ở service worker của extension (IndexedDB của extension, không phải của youtube.com). */
export const extensionCache: TranslationCache = {
  get: (keys) => send<Record<string, string>>({ type: 'CACHE_GET', keys }),
  set: (entries) => send<void>({ type: 'CACHE_SET', entries }),
};
