import { cacheClear, cacheCount, cacheGet, cacheSet } from '../storage/cache.ts';

type CacheMessage =
  | { type: 'CACHE_GET'; keys: string[] }
  | { type: 'CACHE_SET'; entries: Array<[string, string]> }
  | { type: 'CACHE_CLEAR' }
  | { type: 'CACHE_STATS' };

const MAX_ITEMS_PER_CALL = 200;

async function handle(msg: CacheMessage): Promise<unknown> {
  switch (msg.type) {
    case 'CACHE_GET':
      return cacheGet(msg.keys.slice(0, MAX_ITEMS_PER_CALL).map(String));
    case 'CACHE_SET':
      return cacheSet(msg.entries.slice(0, MAX_ITEMS_PER_CALL).map(([k, v]) => [String(k), String(v)]));
    case 'CACHE_CLEAR':
      return cacheClear();
    case 'CACHE_STATS':
      return { entries: await cacheCount() };
  }
}

// Phải đăng ký đồng bộ ở cấp cao nhất: service worker MV3 có thể bị tắt và khởi động lại bất kỳ lúc nào.
chrome.runtime.onMessage.addListener((msg: CacheMessage, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('CACHE_')) return false;
  handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true; // phản hồi bất đồng bộ
});
