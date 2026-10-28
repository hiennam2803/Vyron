/** Cache bản dịch bằng IndexedDB. Chạy trong service worker nên thuộc origin của extension, không phải youtube.com. */
const DB_NAME = 'vyron-cache';
const STORE = 'translations';
export const MAX_ENTRIES = 20000;

interface Entry {
  key: string;
  value: string;
  at: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('at', 'at');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function cacheGet(keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (keys.length === 0) return out;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, 'readonly').objectStore(STORE);
    let remaining = keys.length;
    for (const k of keys) {
      const r = store.get(k);
      r.onsuccess = () => {
        const e = r.result as Entry | undefined;
        if (e) out[k] = e.value;
        if (--remaining === 0) resolve(out);
      };
      r.onerror = () => reject(r.error);
    }
  });
}

export async function cacheSet(entries: Array<[string, string]>): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const now = Date.now();
  for (const [key, value] of entries) store.put({ key, value, at: now } satisfies Entry);
  await txDone(tx);
  await evictIfNeeded();
}

export async function cacheCount(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function cacheClear(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await txDone(tx);
}

/** Xóa các mục ghi cũ nhất (FIFO theo thời điểm ghi) khi vượt MAX_ENTRIES, còn lại 90%. */
async function evictIfNeeded(): Promise<void> {
  const count = await cacheCount();
  if (count <= MAX_ENTRIES) return;
  let toDelete = count - Math.floor(MAX_ENTRIES * 0.9);
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const cursorReq = tx.objectStore(STORE).index('at').openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor && toDelete-- > 0) {
      cursor.delete();
      cursor.continue();
    }
  };
  await txDone(tx);
}
