import { icon } from './icons';

export interface ExtraKeysCallbacks {
  onSendKey: (keysym: number, down: boolean) => void;
  onSendSequence: (keysyms: number[]) => void;
  onToggleSoftKeyboard?: () => void;
  // Fired on every visibility change, not just ones triggered by toggle() - the bar's own close
  // button calls hide() directly, and the left rail's button needs to reflect that too.
  onVisibilityChange?: (visible: boolean) => void;
}

const KEY_CTRL_L = 0xffe3;
const KEY_ALT_L = 0xffe9;
const KEY_SHIFT_L = 0xffe1;
const KEY_SUPER_L = 0xffeb;
const KEY_DELETE = 0xffff;
const KEY_ESCAPE = 0xff1b;
const KEY_TAB = 0xff09;

export class ExtraKeysBar {
  private container: HTMLElement;
  private callbacks: ExtraKeysCallbacks;
  private isVisible: boolean = false;

  // Sticky modifier states
  private ctrlSticky: boolean = false;
  private altSticky: boolean = false;
  private shiftSticky: boolean = false;

  constructor(container: HTMLElement, callbacks: ExtraKeysCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.container.className = 'extra-keys-bar hidden';
    this.container.innerHTML = `
      <div class="extra-keys-inner">
        <button class="key-btn combo-btn" data-action="cad" title="Send Ctrl+Alt+Del">Ctrl+Alt+Del</button>
        <button class="key-btn" data-key="super" title="Send Super/Windows Key">Super</button>
        <button class="key-btn" data-key="esc">Esc</button>
        <button class="key-btn" data-key="tab">Tab</button>
        <button class="key-btn combo-btn" data-action="alttab" title="Send Alt+Tab">Alt+Tab</button>

        <div class="key-separator"></div>

        <button class="key-btn sticky-btn" data-sticky="ctrl">Ctrl</button>
        <button class="key-btn sticky-btn" data-sticky="alt">Alt</button>
        <button class="key-btn sticky-btn" data-sticky="shift">Shift</button>

        <div class="key-separator"></div>

        <div class="f-keys-group">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
            .map((num) => `<button class="key-btn f-btn" data-f="${num}">F${num}</button>`)
            .join('')}
        </div>

        <button class="key-btn soft-kb-btn" title="Toggle On-screen Virtual Keyboard">${icon('keyboard')}</button>
        <button class="key-btn close-keys-btn" title="Close Special Keys Bar">${icon('close')}</button>
      </div>
    `;

    this.bindEvents();
  }

  public toggle(): boolean {
    this.isVisible = !this.isVisible;
    this.container.classList.toggle('hidden', !this.isVisible);
    if (!this.isVisible) {
      this.resetStickyKeys();
    }
    if (this.callbacks.onVisibilityChange) {
      this.callbacks.onVisibilityChange(this.isVisible);
    }
    return this.isVisible;
  }

  public hide(): void {
    this.isVisible = false;
    this.container.classList.add('hidden');
    this.resetStickyKeys();
    if (this.callbacks.onVisibilityChange) {
      this.callbacks.onVisibilityChange(false);
    }
  }

  private resetStickyKeys(): void {
    if (this.ctrlSticky) {
      this.callbacks.onSendKey(KEY_CTRL_L, false);
      this.ctrlSticky = false;
    }
    if (this.altSticky) {
      this.callbacks.onSendKey(KEY_ALT_L, false);
      this.altSticky = false;
    }
    if (this.shiftSticky) {
      this.callbacks.onSendKey(KEY_SHIFT_L, false);
      this.shiftSticky = false;
    }
    this.container.querySelectorAll('.sticky-btn').forEach((b) => b.classList.remove('active'));
  }

  private bindEvents(): void {
    this.container.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('button');
      if (!target) return;

      const action = target.getAttribute('data-action');
      const key = target.getAttribute('data-key');
      const sticky = target.getAttribute('data-sticky');
      const fNum = target.getAttribute('data-f');

      if (action === 'cad') {
        this.callbacks.onSendSequence([KEY_CTRL_L, KEY_ALT_L, KEY_DELETE]);
      } else if (action === 'alttab') {
        this.callbacks.onSendSequence([KEY_ALT_L, KEY_TAB]);
      } else if (key === 'super') {
        this.callbacks.onSendSequence([KEY_SUPER_L]);
      } else if (key === 'esc') {
        this.callbacks.onSendSequence([KEY_ESCAPE]);
      } else if (key === 'tab') {
        this.callbacks.onSendSequence([KEY_TAB]);
      } else if (fNum) {
        const fIndex = parseInt(fNum, 10);
        // F1 is 0xffbe, F12 is 0xffc9
        const keysym = 0xffbe + (fIndex - 1);
        this.callbacks.onSendSequence([keysym]);
      } else if (sticky === 'ctrl') {
        this.ctrlSticky = !this.ctrlSticky;
        target.classList.toggle('active', this.ctrlSticky);
        this.callbacks.onSendKey(KEY_CTRL_L, this.ctrlSticky);
      } else if (sticky === 'alt') {
        this.altSticky = !this.altSticky;
        target.classList.toggle('active', this.altSticky);
        this.callbacks.onSendKey(KEY_ALT_L, this.altSticky);
      } else if (sticky === 'shift') {
        this.shiftSticky = !this.shiftSticky;
        target.classList.toggle('active', this.shiftSticky);
        this.callbacks.onSendKey(KEY_SHIFT_L, this.shiftSticky);
      } else if (target.classList.contains('soft-kb-btn')) {
        if (this.callbacks.onToggleSoftKeyboard) {
          this.callbacks.onToggleSoftKeyboard();
        }
      } else if (target.classList.contains('close-keys-btn')) {
        this.hide();
      }
    });
  }
}

