export type CaptionKind = 'manual' | 'asr';

export interface CaptionTrack {
  languageCode: string;
  name: string;
  kind: CaptionKind; // 'asr' = phụ đề tự động
  vssId: string;
  baseUrl: string;
  isTranslatable: boolean;
}
export type CaptionTrackInfo = Omit<CaptionTrack, 'baseUrl'>;

export interface TranscriptSegment {
  id: string;
  startTime: number; // giây
  endTime: number; // giây (với phụ đề tự động đã cắt tại thời điểm đoạn kế bắt đầu)
  rawEndTime: number; // endTime gốc từ YouTube, trước khi chuẩn hóa
  originalText: string;
  sourceLanguage: string;
}

export interface TranscriptStats {
  count: number;
  sourceCount?: number; // số mảnh phụ đề gốc trước khi gộp thành câu
  overlapCount: number; // số đoạn bắt đầu trước khi đoạn trước kết thúc
  duplicatesRemoved: number;
  estimatedEndCount: number; // số đoạn thiếu duration phải ước lượng endTime
  clippedCount: number; // số đoạn bị cắt endTime vì chồng lấn (chỉ khi bật clipOverlaps)
  firstStart: number;
  lastEnd: number;
}

export type ErrorCode =
  | 'NO_PLAYER'
  | 'VIDEO_MISMATCH'
  | 'NO_CAPTION_TRACKS'
  | 'FETCH_FAILED'
  | 'EMPTY_RESPONSE'
  | 'PARSE_FAILED'
  | 'EMPTY_TRANSCRIPT'
  | 'BRIDGE_TIMEOUT'
  | 'TRANSLATOR_UNSUPPORTED'
  | 'TRANSLATOR_UNAVAILABLE'
  | 'TRANSLATOR_NEEDS_ACTIVATION'
  | 'TRANSLATOR_FAILED'
  | 'UNKNOWN';

export interface VyronError {
  code: ErrorCode;
  message: string;
  hint?: string | undefined;
}

export type Status = 'not-video-page' | 'loading' | 'ready' | 'error';

export interface PlaybackSnapshot {
  currentTime: number;
  duration: number;
  paused: boolean;
  seeking: boolean;
  ended: boolean;
  playbackRate: number;
  adShowing: boolean;
}

export interface StateSnapshot {
  status: Status;
  videoId: string | null;
  error: VyronError | null;
  tracks: CaptionTrackInfo[];
  selectedTrackIndex: number;
  fetchMethod: string | null;
  fetchNote: string | null; // vì sao cách lấy trực tiếp từ baseUrl thất bại (nếu phải dùng phương án dự phòng)
  segmentsVersion: number;
  stats: TranscriptStats | null;
  playback: PlaybackSnapshot | null;
  currentSegmentIndex: number;
  translation: TranslationSnapshot;
  translationVersion: number;
  speech: SpeechSnapshot;
}

export type TranslationPhase =
  | 'idle'
  | 'checking'
  | 'unsupported' // Chrome không có Translator API, hoặc cặp ngôn ngữ không khả dụng
  | 'needs-download' // cần người dùng bấm trên trang để tải gói ngôn ngữ
  | 'downloading'
  | 'preparing'
  | 'ready'
  | 'error'
  | 'not-needed'; // ngôn ngữ nguồn đã là ngôn ngữ đích

export interface TranslationSnapshot {
  phase: TranslationPhase;
  progress: number; // 0..1, khi tải gói ngôn ngữ
  error: VyronError | null;
  total: number;
  translatedCount: number; // số đoạn đã có bản dịch
  failedCount: number; // số đoạn bỏ cuộc sau khi thử lại
  backendCalls: number; // số câu duy nhất thực sự gọi bộ dịch (còn lại lấy từ cache hoặc trùng)
  sourceLanguage: string;
  targetLanguage: string;
}

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean; // true = giọng chạy trên máy; false = có thể gửi văn bản qua mạng
}
export type VoiceStatus = 'loading' | 'ok' | 'no-vietnamese-voice' | 'only-network-voice' | 'unsupported';

export interface SpeechSnapshot {
  status: VoiceStatus;
  voices: VoiceInfo[]; // chỉ giọng tiếng Việt
  selectedVoice: VoiceInfo | null;
  englishVoice: VoiceInfo | null; // giọng đọc từ tiếng Anh xen trong câu (null = không có hoặc đã tắt)
  speaking: boolean;
  lastError: string | null;
  needsActivation: boolean; // Chrome chặn đọc vì trang chưa có thao tác của người dùng
  sync: {
    mode: 'natural' | 'catchup'; // natural: đọc tự nhiên; catchup: đang tăng tốc/gộp câu để bắt kịp video
    rate: number; // tốc độ của câu gần nhất
    lagSeconds: number; // giây thực mà giọng đang chậm hơn phụ đề
    skipped: number; // số đoạn bị bỏ nguyên vì quá cũ
    unitsPerSecond: number; // tốc độ đọc đo được của giọng ở 1.0x
  };
}
