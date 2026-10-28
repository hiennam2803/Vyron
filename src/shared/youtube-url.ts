/** Trả về video ID (11 ký tự) nếu URL là trang xem video YouTube, ngược lại null. */
export function getVideoIdFromUrl(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;

  if (u.pathname === '/watch') {
    const v = u.searchParams.get('v');
    return v && /^[\w-]{11}$/.test(v) ? v : null;
  }
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})(?:\/|$)/);
  return m && m[1] ? m[1] : null;
}
