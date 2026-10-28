export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Khóa cache gồm phiên bản bộ dịch, cặp ngôn ngữ và nội dung nguồn; không phụ thuộc video nên dùng lại được giữa các video. */
export function makeCacheKey(modelId: string, source: string, target: string, text: string): string {
  return `${modelId}|${source}>${target}|${text}`;
}
