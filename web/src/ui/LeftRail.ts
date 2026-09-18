import { icon } from './icons';

export interface LeftRailCallbacks {
  onToggleSpeaker: () => void;
  onToggleClipboardDrawer: () => void;
  onToggleExtraKeys: () => void;
  onToggleSettings: () => void;
  onToggleFullscreen: () => void;
  onTogglePanMode: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}

export class LeftRail {
  private container: HTMLElement;
  private callbacks: LeftRailCallbacks;

  private railBody: HTMLElement;

  private speakerBtn: HTMLButtonElement;
  private extraKeysBtn: HTMLButtonElement;
  private clipboardBtn: HTMLButtonElement;
  private panBtn: HTMLButtonElement;
  private fullscreenBtn: HTMLButtonElement;
  private settingsBtn: HTMLButtonElement;
  private connectBtn: HTMLButtonElement;
  private collapseTab: HTMLElement;

  private isCollapsed: boolean = false;

  constructor(container: HTMLElement, callbacks: LeftRailCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.container.innerHTML = `
      <div class="rail-body">
        <div class="rail-inner">
          <button class="icon-btn action-btn connect-btn" title="Disconnect">
            ${icon('power_settings_new')}
          </button>
          <button class="icon-btn speaker-btn active" title="Toggle Audio Output">
            ${icon('volume_up')}
          </button>
          <button class="icon-btn clipboard-btn" title="Clipboard Sync: OFF — click to open">
            ${icon('content_paste')}
          </button>
          <button class="icon-btn extra-keys-btn" title="Toggle Special Keys Bar (Ctrl+Alt+Del, Super, etc.)">
            ${icon('keyboard')}
          </button>
          <button class="icon-btn pan-btn hidden" title="Pan Mode: OFF — click-drag interacts with the remote desktop normally">
            ${icon('open_with')}
          </button>
          <button class="icon-btn fullscreen-btn" title="Toggle Fullscreen">
            ${icon('fullscreen')}
          </button>
          <button class="icon-btn settings-btn" title="Session Settings">
            ${icon('settings')}
          </button>
        </div>
        <div class="rail-tab" title="Toggle Toolbar">${icon('chevron_left')}</div>
      </div>
    `;

    this.railBody = this.container.querySelector('.rail-body')!;

    this.speakerBtn = this.container.querySelector('.speaker-btn')!;
    this.extraKeysBtn = this.container.querySelector('.extra-keys-btn')!;
    this.clipboardBtn = this.container.querySelector('.clipboard-btn')!;
    this.panBtn = this.container.querySelector('.pan-btn')!;
    this.fullscreenBtn = this.container.querySelector('.fullscreen-btn')!;
    this.settingsBtn = this.container.querySelector('.settings-btn')!;
    this.connectBtn = this.container.querySelector('.connect-btn')!;
    this.collapseTab = this.container.querySelector('.rail-tab')!;

    this.bindEvents();
  }

  // Connection status is reflected on the connect/disconnect button itself (icon + title) -
  // there's no separate floating status indicator anymore.
  public setStatus(state: string, message?: string): void {
    if (state === 'connected') {
      this.connectBtn.title = 'Disconnect';
      this.connectBtn.classList.add('disconnect-mode');
    } else {
      this.connectBtn.title = message || 'Connect';
      this.connectBtn.classList.remove('disconnect-mode');
    }
  }

  public setSpeakerActive(active: boolean): void {
    this.speakerBtn.innerHTML = icon(active ? 'volume_up' : 'volume_off');
    this.speakerBtn.classList.toggle('active', active);
  }

  // Used when the server has no audio backend at all (EnableAudio=false, reported via
  // /api/session's audio_enabled field - see main.ts) - the one case where no client-side
  // action can make the button do anything, so it's disabled rather than left clickable-but-
  // inert. `reason` sets the tooltip. Client-side ?audio=0 deliberately does NOT disable this:
  // AudioClient just starts muted in that case, and the button stays fully functional.
  public setSpeakerDisabled(disabled: boolean, reason?: string): void {
    this.speakerBtn.disabled = disabled;
    this.speakerBtn.classList.toggle('disabled', disabled);
    if (disabled) {
      this.speakerBtn.innerHTML = icon('volume_off');
      this.speakerBtn.classList.remove('active');
      this.speakerBtn.title = reason || 'Audio unavailable';
    } else {
      this.speakerBtn.title = 'Toggle Audio Output';
    }
  }

  public setClipboardActive(active: boolean): void {
    this.clipboardBtn.classList.toggle('active', active);
    this.clipboardBtn.title = `Clipboard Sync: ${active ? 'ON' : 'OFF'} — click to open`;
  }

  public setExtraKeysActive(active: boolean): void {
    this.extraKeysBtn.classList.toggle('active', active);
  }

  // Pan mode only makes sense in 1:1 scale mode (see VncClient.setPanMode) - hidden entirely
  // otherwise rather than just disabled, since it's not a control that applies at all in the
  // scaled modes (there's never anything to pan there).
  public setPanModeAvailable(available: boolean): void {
    this.panBtn.classList.toggle('hidden', !available);
  }

  public setPanModeActive(active: boolean): void {
    this.panBtn.classList.toggle('active', active);
    this.panBtn.title = active
      ? 'Pan Mode: ON — click-drag pans the view instead of interacting with the remote desktop'
      : 'Pan Mode: OFF — click-drag interacts with the remote desktop normally';
  }

  private bindEvents(): void {
    this.speakerBtn.addEventListener('click', () => this.callbacks.onToggleSpeaker());
    this.clipboardBtn.addEventListener('click', () => this.callbacks.onToggleClipboardDrawer());
    this.extraKeysBtn.addEventListener('click', () => this.callbacks.onToggleExtraKeys());
    this.panBtn.addEventListener('click', () => this.callbacks.onTogglePanMode());
    this.fullscreenBtn.addEventListener('click', () => this.callbacks.onToggleFullscreen());
    this.settingsBtn.addEventListener('click', () => this.callbacks.onToggleSettings());

    this.connectBtn.addEventListener('click', () => {
      if (this.connectBtn.classList.contains('disconnect-mode')) {
        this.callbacks.onDisconnect();
      } else {
        this.callbacks.onReconnect();
      }
    });

    this.collapseTab.addEventListener('click', () => {
      this.isCollapsed = !this.isCollapsed;
      this.railBody.classList.toggle('collapsed', this.isCollapsed);
      this.collapseTab.innerHTML = icon(this.isCollapsed ? 'chevron_right' : 'chevron_left');
    });
  }
}
