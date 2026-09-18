import { icon } from './icons';

export interface SoftKeyboardCallbacks {
  onSendKey: (keysym: number, down: boolean) => void;
}

const ARROW_ICONS: Record<string, string> = {
  '←': 'arrow_back',
  '↑': 'arrow_upward',
  '→': 'arrow_forward',
  '↓': 'arrow_downward',
};

// Modifiers that need to stay held while another key is pressed for combos (Ctrl+C, etc.) to
// register on the remote end - unlike every other key here, these toggle on click instead of
// firing a down+up tap, and stay engaged (with a visible active state) until toggled off again.
// Caps is deliberately excluded: a tap already toggles caps-lock state on the remote OS itself,
// and we have no way to query whether it's actually on, so showing a persistent toggle state
// for it would just be a guess.
const STICKY_MODIFIERS: Record<string, number> = {
  Ctrl: 0xffe3,
  Alt: 0xffe9,
  Shift: 0xffe1,
  Super: 0xffeb,
};

export class SoftKeyboard {
  private container: HTMLElement;
  private callbacks: SoftKeyboardCallbacks;
  private isVisible: boolean = false;
  private stickyState: Record<string, boolean> = {};

  constructor(container: HTMLElement, callbacks: SoftKeyboardCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.container.className = 'soft-keyboard hidden';
    this.render();
    this.bindEvents();
  }

  public toggle(): boolean {
    this.isVisible = !this.isVisible;
    this.container.classList.toggle('hidden', !this.isVisible);
    if (!this.isVisible) {
      this.releaseAllSticky();
    }
    return this.isVisible;
  }

  public close(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.container.classList.add('hidden');
    this.releaseAllSticky();
  }

  private releaseAllSticky(): void {
    for (const key of Object.keys(this.stickyState)) {
      if (this.stickyState[key]) {
        this.stickyState[key] = false;
        this.callbacks.onSendKey(STICKY_MODIFIERS[key], false);
      }
    }
    this.container.querySelectorAll('.kb-key.active').forEach((b) => b.classList.remove('active'));
  }

  private render(): void {
    const rows = [
      ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Backspace'],
      ['Tab', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
      ['Caps', 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'", 'Enter'],
      ['Shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 'Shift'],
      ['Ctrl', 'Super', 'Alt', 'Space', 'Alt', 'Ctrl', '←', '↑', '↓', '→'],
    ];

    let html = '<div class="soft-keyboard-inner">';
    html += `<div class="soft-keyboard-header"><button class="icon-btn soft-keyboard-close-btn" title="Close Keyboard">${icon('close')}</button></div>`;
    for (const row of rows) {
      html += '<div class="kb-row">';
      for (const k of row) {
        const cls = k.length > 1 ? `kb-key key-${k.toLowerCase().replace(/[^a-z0-9]/g, '')}` : 'kb-key';
        const label = ARROW_ICONS[k] ? icon(ARROW_ICONS[k] as any) : k;
        html += `<button class="${cls}" data-key="${k}">${label}</button>`;
      }
      html += '</div>';
    }
    html += '</div>';
    this.container.innerHTML = html;
  }

  private bindEvents(): void {
    this.container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;

      if (btn.classList.contains('soft-keyboard-close-btn')) {
        this.close();
        return;
      }

      const k = btn.getAttribute('data-key');
      if (!k) return;

      if (k in STICKY_MODIFIERS) {
        const engaged = !this.stickyState[k];
        this.stickyState[k] = engaged;
        // Both Shift keys share one data-key value and one logical modifier state - keep
        // whichever button(s) match this key in sync rather than just the one clicked.
        this.container.querySelectorAll(`[data-key="${k}"]`).forEach((b) => b.classList.toggle('active', engaged));
        this.callbacks.onSendKey(STICKY_MODIFIERS[k], engaged);
        return;
      }

      let keysym = 0;
      switch (k) {
        case 'Esc': keysym = 0xff1b; break;
        case 'Backspace': keysym = 0xff08; break;
        case 'Tab': keysym = 0xff09; break;
        case 'Enter': keysym = 0xff0d; break;
        case 'Space': keysym = 0x20; break;
        case 'Caps': keysym = 0xffe5; break;
        case '←': keysym = 0xff51; break;
        case '↑': keysym = 0xff52; break;
        case '→': keysym = 0xff53; break;
        case '↓': keysym = 0xff54; break;
        default:
          if (k.length === 1) {
            keysym = k.charCodeAt(0);
          }
          break;
      }

      if (keysym > 0) {
        // Momentary press feedback for a plain tap - CSS :active alone is unreliable on touch
        // (notably mobile Safari, without extra listener tricks), which is why taps here looked
        // like nothing happened even though the key press was actually being sent.
        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 120);
        this.callbacks.onSendKey(keysym, true);
        setTimeout(() => this.callbacks.onSendKey(keysym, false), 50);
      }
    });
  }
}

