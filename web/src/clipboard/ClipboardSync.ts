export interface ClipboardCallbacks {
  onRemoteCut?: (text: string) => void;
  onLocalCut?: (text: string) => void;
  onDrawerRequested?: () => void;
  onSyncStateChange?: (enabled: boolean) => void;
}

export class ClipboardSync {
  private sendClientCutText: (text: string) => void;
  private callbacks: ClipboardCallbacks;

  private enabled: boolean = true;
  private lastRemoteText: string = '';
  private lastLocalText: string = '';
  private history: string[] = [];

  private drawerElement: HTMLElement | null = null;
  private drawerTextarea: HTMLTextAreaElement | null = null;
  private isDrawerOpen: boolean = false;

  constructor(
    sendClientCutText: (text: string) => void,
    callbacks: ClipboardCallbacks = {},
    initialEnabled: boolean = true
  ) {
    this.sendClientCutText = sendClientCutText;
    this.callbacks = callbacks;
    this.enabled = initialEnabled;

    this.initEventListeners();
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    console.log(`[cnt-vnc] Clipboard sync -> ${enabled ? 'enabled' : 'disabled'}`);
    if (this.callbacks.onSyncStateChange) {
      this.callbacks.onSyncStateChange(enabled);
    }
  }

  public toggleEnabled(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /**
   * Called when remote VNC server cuts text (ServerCutText).
   */
  public handleServerCut(text: string): void {
    if (!text || text === this.lastRemoteText) return;
    this.lastRemoteText = text;
    this.addToHistory(text);

    // Update drawer textarea if present
    if (this.drawerTextarea) {
      this.drawerTextarea.value = text;
    }

    // If clipboard sync is disabled, do NOT write to local clipboard or fire remote cut callback
    if (!this.enabled) {
      console.debug('[cnt-vnc] Server cut text received, but clipboard sync is disabled');
      return;
    }

    // Tier 1: Try modern Async Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch((err) => {
        // Expected in inactive tab or on some Safari versions without user gesture
        console.debug('Async clipboard write deferred to drawer/gesture:', err);
      });
    }

    if (this.callbacks.onRemoteCut) {
      this.callbacks.onRemoteCut(text);
    }
  }

  /**
   * Sends text from browser/local clipboard to remote VNC desktop.
   * If force is true, sends even if automatic sync is disabled (e.g. user manually typed in drawer).
   */
  public sendLocalText(text: string, force: boolean = false): void {
    if (!text || text === this.lastLocalText) return;
    if (!this.enabled && !force) {
      console.debug('[cnt-vnc] Local cut text not sent: clipboard sync is disabled');
      return;
    }
    this.lastLocalText = text;
    this.addToHistory(text);
    this.sendClientCutText(text);

    if (this.callbacks.onLocalCut) {
      this.callbacks.onLocalCut(text);
    }
  }

  /**
   * Checks local OS clipboard and sends to remote if changed.
   */
  public async syncFromLocalClipboard(): Promise<void> {
    if (!this.enabled) return;
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text !== this.lastLocalText && text !== this.lastRemoteText) {
          this.sendLocalText(text);
        }
      } catch (err) {
        // In Firefox or Safari without permission, falls back to native paste event or drawer
      }
    }
  }

  public getHistory(): string[] {
    return [...this.history];
  }

  public clearHistory(): void {
    this.history = [];
  }

  public bindDrawer(drawer: HTMLElement, textarea: HTMLTextAreaElement): void {
    this.drawerElement = drawer;
    this.drawerTextarea = textarea;
  }

  public toggleDrawer(): boolean {
    this.isDrawerOpen = !this.isDrawerOpen;
    if (this.drawerElement) {
      if (this.isDrawerOpen) {
        this.drawerElement.classList.add('open');
        if (this.drawerTextarea) {
          this.drawerTextarea.value = this.lastRemoteText;
          this.drawerTextarea.focus();
        }
      } else {
        this.drawerElement.classList.remove('open');
      }
    }
    return this.isDrawerOpen;
  }

  private initEventListeners(): void {
    // Tier 2: Native DOM paste event
    // Supported on Firefox, Safari, and Chrome with zero permission popups
    window.addEventListener('paste', (e: ClipboardEvent) => {
      if (!this.enabled) return;

      // Don't intercept if user is typing in another input element
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      if (activeTag === 'input' || (activeTag === 'textarea' && document.activeElement !== this.drawerTextarea)) {
        return;
      }

      const pastedText = e.clipboardData?.getData('text/plain');
      if (pastedText) {
        this.sendLocalText(pastedText);
      }
    });

    // Check clipboard on window focus
    window.addEventListener('focus', () => {
      this.syncFromLocalClipboard();
    });
  }

  private addToHistory(text: string): void {
    if (!text.trim()) return;
    this.history = [text, ...this.history.filter((item) => item !== text)].slice(0, 5);
  }
}

