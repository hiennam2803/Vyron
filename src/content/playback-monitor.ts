import type { PlaybackSnapshot } from '../shared/types.ts';
import { isAdShowing } from './youtube-adapter.ts';

const EVENTS = [
  'play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange',
  'ended', 'emptied', 'loadedmetadata', 'waiting',
] as const;

export type MonitorEventName = (typeof EVENTS)[number];

/**
 * Theo dõi trạng thái HTMLMediaElement. Không dựa riêng vào `timeupdate` (chỉ ~4Hz):
 * khi đang phát, thêm tick 100ms để xác định đoạn hiện tại chính xác hơn.
 */
export class PlaybackMonitor {
  private video: HTMLVideoElement;
  private onEvent: (name: MonitorEventName, snap: PlaybackSnapshot) => void;
  private onTick: (snap: PlaybackSnapshot) => void;
  private timer: number | null = null;
  private listeners: Array<[MonitorEventName, () => void]> = [];

  constructor(
    video: HTMLVideoElement,
    onEvent: (name: MonitorEventName, snap: PlaybackSnapshot) => void,
    onTick: (snap: PlaybackSnapshot) => void,
  ) {
    this.video = video;
    this.onEvent = onEvent;
    this.onTick = onTick;
  }

  start(): void {
    for (const name of EVENTS) {
      const handler = () => {
        const snap = this.snapshot();
        this.onEvent(name, snap);
        this.onTick(snap);
        this.updateTimer();
      };
      this.video.addEventListener(name, handler);
      this.listeners.push([name, handler]);
    }
    this.video.addEventListener('timeupdate', this.timeupdate);
    this.updateTimer();
    this.onTick(this.snapshot());
  }

  stop(): void {
    for (const [name, handler] of this.listeners) this.video.removeEventListener(name, handler);
    this.listeners = [];
    this.video.removeEventListener('timeupdate', this.timeupdate);
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): PlaybackSnapshot {
    const v = this.video;
    return {
      currentTime: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      paused: v.paused,
      seeking: v.seeking,
      ended: v.ended,
      playbackRate: v.playbackRate,
      adShowing: isAdShowing(),
    };
  }

  private timeupdate = (): void => {
    this.onTick(this.snapshot());
  };

  private updateTimer(): void {
    const shouldRun = !this.video.paused && !this.video.ended;
    if (shouldRun && this.timer === null) {
      this.timer = window.setInterval(() => this.onTick(this.snapshot()), 100);
    } else if (!shouldRun && this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
