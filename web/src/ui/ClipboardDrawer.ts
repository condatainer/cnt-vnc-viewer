import { icon } from './icons';

export interface ClipboardDrawerCallbacks {
  onSendText: (text: string) => void;
  onToggleSync?: (enabled: boolean) => void;
  onClearHistory?: () => void;
}

export class ClipboardDrawer {
  private container: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private callbacks: ClipboardDrawerCallbacks;
  private isOpen: boolean = false;

  constructor(container: HTMLElement, callbacks: ClipboardDrawerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.container.className = 'clipboard-drawer';
    this.container.innerHTML = `
      <div class="drawer-header">
        <div class="drawer-header-left">
          <h4>Clipboard Sync</h4>
          <span class="sync-status-badge active">ON</span>
        </div>
        <div class="drawer-header-right">
          <label class="toggle-switch" title="Toggle automatic clipboard synchronization">
            <input type="checkbox" class="drawer-sync-toggle" checked>
            <span class="toggle-slider"></span>
          </label>
          <button class="icon-btn drawer-close-btn" title="Close Drawer">${icon('close')}</button>
        </div>
      </div>
      <div class="drawer-body">
        <textarea class="clipboard-textarea" placeholder="Type or paste text, then Send to Remote..."></textarea>
        <div class="drawer-actions">
          <button class="drawer-btn send-btn" title="Send Text to Remote Desktop">Send to Remote</button>
          <button class="drawer-btn copy-btn" title="Copy to Local Clipboard">Copy to Local</button>
          <button class="drawer-btn clear-btn" title="Clear Textarea">Clear</button>
        </div>
        <div class="clipboard-history-box">
          <div class="history-header">
            <h5>Recent History</h5>
            <button class="icon-btn icon-btn-sm history-clear-btn" title="Clear History">${icon('delete')}</button>
          </div>
          <ul class="clipboard-history-list"></ul>
        </div>
      </div>
    `;

    this.textarea = this.container.querySelector('.clipboard-textarea')!;
    this.bindEvents();
  }

  public getTextarea(): HTMLTextAreaElement {
    return this.textarea;
  }

  public getContainer(): HTMLElement {
    return this.container;
  }

  public toggle(): boolean {
    this.isOpen = !this.isOpen;
    this.container.classList.toggle('open', this.isOpen);
    if (this.isOpen) {
      // preventScroll: without it, focusing this off-viewport textarea mid-slide-in makes
      // the browser auto-scroll the (overflow:hidden but still scrollable) #app container
      // to reveal it, visibly shoving the whole app left and back once the scroll resets.
      this.textarea.focus({ preventScroll: true });
    }
    return this.isOpen;
  }

  public setContent(text: string): void {
    this.textarea.value = text;
  }

  public updateHistory(items: string[]): void {
    const list = this.container.querySelector('.clipboard-history-list')!;
    list.innerHTML = '';
    items.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = item.length > 60 ? `${item.slice(0, 57)}...` : item;
      li.title = item;
      li.addEventListener('click', () => {
        this.textarea.value = item;
        this.callbacks.onSendText(item);
      });
      list.appendChild(li);
    });
  }

  public setSyncActive(active: boolean): void {
    const toggle = this.container.querySelector('.drawer-sync-toggle') as HTMLInputElement;
    const badge = this.container.querySelector('.sync-status-badge') as HTMLElement;
    if (toggle) toggle.checked = active;
    if (badge) {
      badge.textContent = active ? 'ON' : 'OFF';
      badge.className = `sync-status-badge ${active ? 'active' : 'paused'}`;
    }
  }

  private bindEvents(): void {
    const closeBtn = this.container.querySelector('.drawer-close-btn')!;
    const sendBtn = this.container.querySelector('.send-btn')!;
    const copyBtn = this.container.querySelector('.copy-btn')!;
    const clearBtn = this.container.querySelector('.clear-btn')!;
    const historyClearBtn = this.container.querySelector('.history-clear-btn')!;
    const syncToggle = this.container.querySelector('.drawer-sync-toggle') as HTMLInputElement;

    closeBtn.addEventListener('click', () => this.toggle());

    if (syncToggle) {
      syncToggle.addEventListener('change', () => {
        if (this.callbacks.onToggleSync) {
          this.callbacks.onToggleSync(syncToggle.checked);
        }
      });
    }

    if (sendBtn) {
      sendBtn.addEventListener('click', () => {
        if (this.textarea.value) {
          this.callbacks.onSendText(this.textarea.value);
          sendBtn.textContent = 'Sent!';
          setTimeout(() => (sendBtn.textContent = 'Send to Remote'), 1500);
        }
      });
    }

    copyBtn.addEventListener('click', () => {
      if (this.textarea.value) {
        navigator.clipboard.writeText(this.textarea.value).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => (copyBtn.textContent = 'Copy to Local'), 1500);
        });
      }
    });

    clearBtn.addEventListener('click', () => {
      this.textarea.value = '';
    });

    historyClearBtn.addEventListener('click', () => {
      this.updateHistory([]);
      this.callbacks.onClearHistory?.();
    });
  }
}

