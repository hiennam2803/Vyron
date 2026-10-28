/** Bảng chẩn đoán trên trang (Shadow DOM). Mặc định ẨN; bật trong popup → Nâng cao → "Hiện bảng chẩn đoán". */
export class DebugHud {
  private host: HTMLElement;
  private box: HTMLElement;
  private body: HTMLPreElement;
  private last = '';
  private shown = false;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'vyron-debug-hud';
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .box { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; width: 380px;
        background: rgba(28,27,32,.94); color: #f3f0e8; border: 1px solid #3a3744; border-radius: 12px;
        font: 11.5px/1.45 "Cascadia Mono", Consolas, monospace; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
      header { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px;
        border-bottom: 1px solid #3a3744; color: #b7a6f0; cursor: pointer; user-select: none; }
      pre { margin: 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; }
      .box.collapsed pre { display: none; }
    `;
    this.box = document.createElement('div');
    this.box.className = 'box';
    const header = document.createElement('header');
    const title = document.createElement('span');
    title.textContent = 'VYRON · chẩn đoán';
    const hint = document.createElement('span');
    hint.textContent = 'bấm để thu gọn';
    header.append(title, hint);
    header.addEventListener('click', () => this.box.classList.toggle('collapsed'));
    this.body = document.createElement('pre');
    this.box.append(header, this.body);
    root.append(style, this.box);
  }

  setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    if (visible) document.documentElement.appendChild(this.host);
    else this.host.remove();
  }

  setText(text: string): void {
    if (!this.shown || text === this.last) return;
    this.last = text;
    this.body.textContent = text;
  }
}
