/** Mọi giả định về DOM của YouTube nằm ở đây để dễ sửa khi YouTube thay đổi. */

export function findVideoElement(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('#movie_player video.html5-main-video') ??
    document.querySelector<HTMLVideoElement>('video.html5-main-video') ??
    document.querySelector<HTMLVideoElement>('video')
  );
}

/** Khi đang chiếu quảng cáo, <video> phát quảng cáo nên currentTime KHÔNG thuộc video chính. */
export function isAdShowing(): boolean {
  return document.querySelector('.html5-video-player.ad-showing') !== null;
}

export const NAVIGATION_EVENTS = ['yt-navigate-start', 'yt-navigate-finish', 'popstate'] as const;
