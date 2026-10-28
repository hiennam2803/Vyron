export const TARGET_LANGUAGE = 'vi';
/** Đổi giá trị này khi đổi bộ dịch để cache cũ không bị dùng nhầm. */
export const TRANSLATION_MODEL_ID = 'chrome-translator-v1';
/** Số đoạn dịch trước tính từ vị trí đang phát. Không dịch toàn bộ video. */
export const LOOKAHEAD_SEGMENTS = 30;
/** Số câu gửi cho bộ dịch mỗi lô. Lô nhỏ để hủy/chuyển hướng nhanh khi người dùng tua. */
export const BATCH_SIZE = 6;
