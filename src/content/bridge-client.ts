import { BRIDGE_REQ, BRIDGE_RES } from '../shared/protocol.ts';
import type { BridgeCall, BridgeProgress, BridgeRequest, BridgeResponse } from '../shared/protocol.ts';
import type { VyronError } from '../shared/types.ts';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: VyronError) => void;
  onProgress: ((p: number) => void) | undefined;
  arm: () => void; // đặt lại đồng hồ timeout
  timer: number;
}
const pending = new Map<number, Pending>();
let nextId = 1;
let listening = false;

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const d = ev.data as BridgeResponse | BridgeProgress | null;
    if (!d || d.source !== BRIDGE_RES || typeof d.id !== 'number') return;
    const p = pending.get(d.id);
    if (!p) return;
    if ('progress' in d) {
      p.onProgress?.(d.progress);
      p.arm(); // còn hoạt động -> gia hạn timeout
      return;
    }
    pending.delete(d.id);
    window.clearTimeout(p.timer);
    if (d.ok) p.resolve(d.data);
    else p.reject(d.error);
  });
}

/** timeoutMs tính từ lần nhận tin gần nhất (kể cả tin tiến độ). */
export function bridgeCall<T>(call: BridgeCall, timeoutMs = 8000, onProgress?: (p: number) => void): Promise<T> {
  ensureListener();
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const entry: Pending = {
      resolve: resolve as (v: unknown) => void,
      reject,
      onProgress,
      timer: 0,
      arm: () => {
        window.clearTimeout(entry.timer);
        entry.timer = window.setTimeout(() => {
          pending.delete(id);
          reject({
            code: 'BRIDGE_TIMEOUT',
            message: 'Không nhận được phản hồi từ page-bridge (MAIN world).',
            hint: 'Kiểm tra Chrome ≥ 111 (chrome://version), nạp lại extension rồi tải lại tab YouTube.',
          } satisfies VyronError);
        }, timeoutMs);
      },
    };
    entry.arm();
    pending.set(id, entry);
    const req: BridgeRequest = { source: BRIDGE_REQ, id, ...call };
    window.postMessage(req, location.origin);
  });
}
