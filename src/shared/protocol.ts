import type { CaptionTrack, VyronError } from './types.ts';

// ---- content script (isolated world) <-> page bridge (MAIN world), qua window.postMessage ----
export const BRIDGE_REQ = 'vyron-content' as const;
export const BRIDGE_RES = 'vyron-page' as const;

export type BridgeCall =
  | { type: 'GET_TRACKS'; videoId: string }
  | {
      type: 'FETCH_TRACK';
      videoId: string;
      track: Pick<CaptionTrack, 'baseUrl' | 'languageCode' | 'kind'>;
    }
  | { type: 'TR_AVAILABILITY'; srcLang: string; tgtLang: string }
  | { type: 'TR_PREPARE'; srcLang: string; tgtLang: string }
  | { type: 'TR_TRANSLATE_BATCH'; srcLang: string; tgtLang: string; texts: string[] };

export type BridgeRequest = { source: typeof BRIDGE_REQ; id: number } & BridgeCall;
export type BridgeResponse = { source: typeof BRIDGE_RES; id: number } & (
  | { ok: true; data: unknown }
  | { ok: false; error: VyronError }
);

/** Tiến độ gửi kèm id của yêu cầu đang chạy (ví dụ tải gói ngôn ngữ). */
export interface BridgeProgress {
  source: typeof BRIDGE_RES;
  id: number;
  progress: number;
}

export type TrAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported-api';
export interface TrAvailabilityResult {
  availability: TrAvailability;
}
export interface TrBatchResult {
  items: Array<{ ok: true; text: string } | { ok: false; message: string }>;
}

export interface GetTracksResult {
  tracks: CaptionTrack[];
}
export interface FetchTrackResult {
  method: 'baseUrl' | 'player-captured';
  body: string;
  firstAttemptFailure: string | null; // lý do baseUrl thất bại khi method = 'player-captured'
}

// ---- popup <-> content script, qua chrome.tabs.sendMessage ----
export type PopupRequest = { type: 'GET_STATE' } | { type: 'RELOAD' } | { type: 'RETRY_TRANSLATION' };
