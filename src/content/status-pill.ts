/**
 * Nhãn trạng thái nhỏ nằm TRONG khung player YouTube (nên vẫn thấy khi toàn màn hình).
 * Thay thế bảng debug cũ: gọn, tự mờ đi sau vài giây, chỉ đứng yên khi cần người dùng bấm (tải gói ngôn ngữ).
 */
export type PillTone = 'live' | 'busy' | 'info' | 'warn' | 'error';

export interface PillState {
  tone: PillTone;
  text: string;
  /** Chi tiết phụ (ví dụ tốc độ). Đổi chi tiết không làm nhãn hiện lại. */
  detail?: string;
  action?: { label: string; onClick: () => void };
  /** Giữ nhãn hiện cho tới khi trạng thái đổi (dùng khi cần người dùng thao tác). */
  sticky?: boolean;
}

const HIDE_AFTER_MS = 3800;

export class StatusPill {
  private host: HTMLElement;
  private pill: HTMLElement;
  private dotLabel: HTMLElement;
  private detail: HTMLElement;
  private button: HTMLButtonElement;
  private handler: (() => void) | null = null;
  private key = '';
  private hideTimer: number | null = null;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'vyron-pill';
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .layer { position: absolute; inset: 0; pointer-events: none; z-index: 2000; }
      .layer.fixed { position: fixed; z-index: 2147483647; }
      .pill {
        position: absolute; left: 14px; bottom: 78px; display: flex; align-items: center; gap: 9px;
        max-width: min(440px, calc(100% - 28px)); padding: 7px 13px 7px 11px; border-radius: 999px;
        background: rgba(28, 27, 32, .84); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        color: #f3f0e8; font: 500 13px/1.25 "Segoe UI", system-ui, sans-serif; letter-spacing: .005em;
        box-shadow: 0 4px 18px rgba(0,0,0,.35), inset 0 0 0 1px rgba(183,166,240,.28);
        opacity: 0; transform: translateY(6px); transition: opacity .25s ease, transform .25s ease;
        pointer-events: none; user-select: none;
      }
      .pill.on { opacity: 1; transform: none; }
      .pill.has-action { pointer-events: auto; }
      .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #b7a6f0; }
      .pill[data-tone="live"] .dot { background: #8fe3b0; animation: pulse 1.5s ease-out infinite; }
      .pill[data-tone="busy"] .dot { animation: blink 1s ease-in-out infinite; }
      .pill[data-tone="warn"] .dot { background: #f2c57c; }
      .pill[data-tone="error"] .dot { background: #f0a6a6; }
      .brand { font-weight: 700; font-size: 11px; letter-spacing: .14em; color: #b7a6f0; }
      .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .detail { color: #9a96a6; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .detail:empty { display: none; }
      button {
        pointer-events: auto; cursor: pointer; font: inherit; font-weight: 600; color: #1c1b20;
        background: #b7a6f0; border: 0; border-radius: 999px; padding: 4px 11px; margin-left: 2px;
      }
      button[hidden] { display: none; }
      button:hover { background: #c9bcf6; }
      button:focus-visible { outline: 2px solid #f3f0e8; outline-offset: 2px; }
      @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(143,227,176,.55); } 100% { box-shadow: 0 0 0 8px rgba(143,227,176,0); } }
      @keyframes blink { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) { .dot, .pill { animation: none !important; transition: none; } }
    `;
    const layer = document.createElement('div');
    layer.className = 'layer';
    this.pill = document.createElement('div');
    this.pill.className = 'pill';
    this.pill.setAttribute('role', 'status');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.textContent = 'VYRON';
    this.dotLabel = document.createElement('span');
    this.dotLabel.className = 'label';
    this.detail = document.createElement('span');
    this.detail.className = 'detail';
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.hidden = true;
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handler?.();
    });
    this.pill.append(dot, brand, this.dotLabel, this.detail, this.button);
    layer.append(this.pill);
    root.append(style, layer);
  }

  /** Gắn vào player hiện tại (YouTube có thể tạo lại player khi chuyển video). */
  private attach(): void {
    const player = document.querySelector<HTMLElement>('#movie_player');
    const parent = player ?? document.documentElement;
    const layer = this.host.shadowRoot?.querySelector('.layer');
    layer?.classList.toggle('fixed', !player);
    if (this.host.parentElement !== parent) parent.appendChild(this.host);
  }

  show(state: PillState): void {
    this.attach();
    this.detail.textContent = state.detail ?? '';
    this.handler = state.action?.onClick ?? null;
    const hasAction = !!state.action;
    this.button.hidden = !hasAction;
    this.button.textContent = state.action?.label ?? '';
    this.pill.classList.toggle('has-action', hasAction);

    const key = `${state.tone}|${state.text}|${state.sticky ? 1 : 0}|${state.action?.label ?? ''}`;
    if (key === this.key) return; // cùng trạng thái: không hiện lại sau khi đã tự mờ đi
    this.key = key;
    this.pill.dataset.tone = state.tone;
    this.dotLabel.textContent = state.text;
    this.pill.classList.add('on');
    this.clearTimer();
    if (!state.sticky) {
      this.hideTimer = window.setTimeout(() => this.fade(), HIDE_AFTER_MS);
    }
  }

  /** Không còn gì đáng báo: ẩn ngay và quên trạng thái cũ để lần sau cùng nội dung vẫn hiện lại. */
  clear(): void {
    this.clearTimer();
    this.fade();
    this.key = '';
  }

  private fade(): void {
    this.pill.classList.remove('on');
    this.pill.classList.remove('has-action');
  }

  private clearTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}
