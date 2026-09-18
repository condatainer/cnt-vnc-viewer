import { VncConfig, ScaleMode } from '../url/urlConfig';
import { icon } from './icons';

export interface SettingsCallbacks {
  onQualityChange: (quality: number) => void;
  onCompressionChange: (compression: number) => void;
  onScaleChange: (mode: ScaleMode) => void;
  onDpiChange: (dpi: number) => void;
  onAudioQualityChange: (sampleRate: number, channels: number) => void;
  onViewOnlyChange: (viewOnly: boolean) => void;
  // One-shot resize requests - independent of the current scale mode (see VncClient's
  // requestExactResolution/requestWindowFitResolution for why).
  onRequestResolution?: (width: number, height: number) => void;
  onRequestWindowFitResolution?: () => void;
}

export class SettingsModal {
  private container: HTMLElement;
  private config: VncConfig;
  private callbacks: SettingsCallbacks;
  private isOpen: boolean = false;
  private selectedRatio: string = 'free';

  private static readonly RATIOS: Record<string, [number, number]> = {
    '4:3': [4, 3],
    '16:9': [16, 9],
    '21:9': [21, 9],
  };

  // 'window' isn't a fixed ratio like the others above - it tracks whatever the browser
  // window's aspect ratio actually is *right now*, so it has to be computed live rather than
  // looked up from RATIOS.
  private getRatio(key: string): [number, number] | undefined {
    if (key === 'window') {
      return [window.innerWidth, window.innerHeight];
    }
    return SettingsModal.RATIOS[key];
  }

  constructor(container: HTMLElement, config: VncConfig, callbacks: SettingsCallbacks) {
    this.container = container;
    this.config = config;
    this.callbacks = callbacks;

    this.container.className = 'modal-backdrop hidden';
    this.container.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-header">
          <h3>VNC & HPC Session Settings</h3>
          <button class="modal-close-btn">${icon('close')}</button>
        </div>
        <div class="modal-body">
          <div class="setting-group">
            <label class="setting-label setting-label-row">
              <span>Scaling & Resolution</span>
              <span class="current-resolution-label">—</span>
            </label>
            <div class="setting-row">
              <span>Scaling Mode:</span>
              <select class="settings-scale-select">
                <option value="fit">Fit Screen (Maintain Aspect Ratio)</option>
                <option value="remote-resize">Remote Resize (RandR Dynamic)</option>
                <option value="down">Scale Down Only</option>
                <option value="none">1:1 Native Resolution</option>
              </select>
            </div>
          </div>

          <div class="setting-group dpi-scale-group hidden">
            <div class="setting-row">
              <span>Scale Factor:</span>
              <div class="dpi-control">
                <input type="range" class="dpi-slider" min="0.5" max="3" step="0.25" list="dpi-ticks">
                <input type="number" class="dpi-number" min="0.5" max="3" step="0.01">
                <span class="dpi-unit">x</span>
              </div>
            </div>
            <datalist id="dpi-ticks">
              <option value="0.5"></option>
              <option value="0.75"></option>
              <option value="1"></option>
              <option value="1.25"></option>
              <option value="1.5"></option>
              <option value="1.75"></option>
              <option value="2"></option>
              <option value="2.25"></option>
              <option value="2.5"></option>
              <option value="2.75"></option>
              <option value="3"></option>
            </datalist>
          </div>

          <div class="setting-group manual-res-group hidden">
            <div class="setting-row">
              <span>Aspect Ratio:</span>
              <div class="btn-toggle-group ratio-btn-group">
                <button class="key-btn ratio-btn active" data-ratio="free">Free</button>
                <button class="key-btn ratio-btn" data-ratio="4:3">4:3</button>
                <button class="key-btn ratio-btn" data-ratio="16:9">16:9</button>
                <button class="key-btn ratio-btn" data-ratio="21:9">21:9</button>
                <button class="key-btn ratio-btn" data-ratio="window" title="Match the current browser window's aspect ratio">Window</button>
              </div>
            </div>
            <div class="setting-row">
              <span>Common Size:</span>
              <div class="btn-toggle-group preset-btn-group">
                <button class="key-btn preset-btn" data-height="720">720p</button>
                <button class="key-btn preset-btn" data-height="1080">1080p</button>
                <button class="key-btn preset-btn" data-height="1440">1440p</button>
                <button class="key-btn preset-btn" data-height="2160">4K</button>
                <button class="key-btn preset-btn" data-height="window" title="Use the current browser window's height (width follows the selected aspect ratio)">Window</button>
              </div>
            </div>
            <div class="setting-row">
              <span>Resolution:</span>
              <div class="resolution-inputs">
                <input type="number" class="res-width-input" min="64" max="7680" step="2" placeholder="W">
                <span>&times;</span>
                <input type="number" class="res-height-input" min="64" max="4320" step="2" placeholder="H">
              </div>
            </div>
            <div class="setting-row">
              <span></span>
              <div class="resolution-actions">
                <button class="drawer-btn res-apply-btn" title="Request this exact resolution from the server, right now">Apply</button>
                <button class="drawer-btn res-auto-btn" title="Request the server resize to match your current browser window size, right now">Fit to Window</button>
              </div>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">Encoding Quality (TurboVNC / TigerVNC)</label>
            <div class="setting-row">
              <span>JPEG Quality (0-9):</span>
              <div class="slider-wrapper">
                <input type="range" class="quality-slider" min="0" max="9" value="${config.quality}">
                <span class="quality-val">${config.quality}</span>
              </div>
            </div>
            <div class="setting-row">
              <span>Compression Level (0-9):</span>
              <div class="slider-wrapper">
                <input type="range" class="comp-slider" min="0" max="9" value="${config.compression}">
                <span class="comp-val">${config.compression}</span>
              </div>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">Speaker Audio (Opus)</label>
            <div class="setting-row audio-format-row">
              <div class="audio-format-item">
                <span>Rate:</span>
                <select class="settings-audio-rate-select">
                  <option value="8000">8 kHz</option>
                  <option value="12000">12 kHz</option>
                  <option value="16000">16 kHz</option>
                  <option value="24000">24 kHz</option>
                  <option value="48000">48 kHz</option>
                </select>
              </div>
              <div class="audio-format-item">
                <span>Channels:</span>
                <div class="btn-toggle-group audio-channel-btn-group">
                  <button class="key-btn audio-channel-btn" data-channels="1">Mono</button>
                  <button class="key-btn audio-channel-btn" data-channels="2">Stereo</button>
                </div>
              </div>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">Session</label>
            <div class="setting-row">
              <span>View Only (disable keyboard/mouse/clipboard input):</span>
              <label class="toggle-switch" title="Toggle view-only mode">
                <input type="checkbox" class="settings-view-only-toggle">
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">Session Info</label>
            <div class="telemetry-box">
              <div class="telem-row"><span>Job Scheduler:</span> <strong id="telem-sched">Detecting...</strong></div>
              <div class="telem-row"><span>Job ID:</span> <strong id="telem-jobid">None</strong></div>
              <div class="telem-row"><span>Walltime Remaining:</span> <strong id="telem-walltime">N/A</strong></div>
              <div class="telem-row"><span>Target Server:</span> <strong id="telem-vnc">127.0.0.1:5901</strong></div>
              <div class="telem-row"><span>Version:</span> <strong id="telem-version">-</strong></div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="action-btn modal-done-btn">Done</button>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  public open(): void {
    this.isOpen = true;
    this.container.classList.remove('hidden');
    this.syncFromConfig();
    this.refreshTelemetry();
  }

  // Called from main.ts's onDesktopResize, which fires on every server-reported resize -
  // initial connect, RandR change, or a one-shot manual resolution request - so this stays
  // live whether or not the modal happens to be open at the time.
  public setCurrentResolution(width: number, height: number): void {
    const label = this.container.querySelector('.current-resolution-label');
    if (label) label.textContent = `${width}×${height}`;
  }

  public setScaleMode(mode: ScaleMode): void {
    this.config.scale = mode;
    const scaleSel = this.container.querySelector('.settings-scale-select') as HTMLSelectElement;
    if (scaleSel) {
      scaleSel.value = mode;
    }
    this.updateModeVisibility();
  }

  private updateModeVisibility(): void {
    const isRandR = this.config.scale === 'remote-resize';
    // Scale only means anything while RandR is continuously re-requesting a resolution to
    // match the window; manual resolution only means anything when nothing else is about
    // to overwrite it a moment later, i.e. everywhere except RandR - mutually exclusive.
    const dpiGroup = this.container.querySelector('.dpi-scale-group');
    const resGroup = this.container.querySelector('.manual-res-group');
    if (dpiGroup) dpiGroup.classList.toggle('hidden', !isRandR);
    if (resGroup) resGroup.classList.toggle('hidden', isRandR);
  }

  public syncFromConfig(): void {
    const scaleSel = this.container.querySelector('.settings-scale-select') as HTMLSelectElement;
    if (scaleSel) scaleSel.value = this.config.scale;
    this.updateModeVisibility();

    const dpiSlider = this.container.querySelector('.dpi-slider') as HTMLInputElement;
    const dpiNumber = this.container.querySelector('.dpi-number') as HTMLInputElement;
    if (dpiSlider) dpiSlider.value = this.config.dpiScale.toString();
    if (dpiNumber) dpiNumber.value = this.config.dpiScale.toString();

    const qSlider = this.container.querySelector('.quality-slider') as HTMLInputElement;
    const qVal = this.container.querySelector('.quality-val') as HTMLElement;
    if (qSlider) {
      qSlider.value = this.config.quality.toString();
      if (qVal) qVal.textContent = this.config.quality.toString();
    }

    const cSlider = this.container.querySelector('.comp-slider') as HTMLInputElement;
    const cVal = this.container.querySelector('.comp-val') as HTMLElement;
    if (cSlider) {
      cSlider.value = this.config.compression.toString();
      if (cVal) cVal.textContent = this.config.compression.toString();
    }

    const rateSel = this.container.querySelector('.settings-audio-rate-select') as HTMLSelectElement;
    if (rateSel) rateSel.value = this.config.audioSampleRate.toString();
    const channelBtns = this.container.querySelectorAll('.audio-channel-btn');
    channelBtns.forEach((btn) => {
      const c = parseInt((btn as HTMLElement).dataset.channels || '0', 10);
      btn.classList.toggle('active', c === this.config.audioChannels);
    });
  }

  public close(): void {
    this.isOpen = false;
    this.container.classList.add('hidden');
  }

  public toggle(): boolean {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
    return this.isOpen;
  }

  private async refreshTelemetry(): Promise<void> {
    try {
      const res = await fetch('/api/session');
      if (res.ok) {
        const data = await res.json();
        const schedEl = this.container.querySelector('#telem-sched');
        const jobEl = this.container.querySelector('#telem-jobid');
        const wallEl = this.container.querySelector('#telem-walltime');
        const vncEl = this.container.querySelector('#telem-vnc');
        const versionEl = this.container.querySelector('#telem-version');

        if (schedEl) schedEl.textContent = data.job_scheduler || 'Local / Interactive';
        if (jobEl) jobEl.textContent = data.job_id || 'N/A';
        if (vncEl) vncEl.textContent = data.vnc_target || 'Default';
        if (versionEl) versionEl.textContent = data.version || 'unknown';

        if (wallEl && data.walltime_remaining_sec) {
          const s = data.walltime_remaining_sec;
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          wallEl.textContent = `${h}h ${m}m remaining`;
        }
      }
    } catch (e) {
      // Ignore in offline / dev mode
    }
  }

  private bindEvents(): void {
    const closeBtn = this.container.querySelector('.modal-close-btn')!;
    const doneBtn = this.container.querySelector('.modal-done-btn')!;
    closeBtn.addEventListener('click', () => this.close());
    doneBtn.addEventListener('click', () => this.close());

    // Quality slider
    const qSlider = this.container.querySelector('.quality-slider') as HTMLInputElement;
    const qVal = this.container.querySelector('.quality-val') as HTMLElement;
    qSlider.addEventListener('input', () => {
      const v = parseInt(qSlider.value, 10);
      qVal.textContent = v.toString();
      this.callbacks.onQualityChange(v);
    });

    // Compression slider
    const cSlider = this.container.querySelector('.comp-slider') as HTMLInputElement;
    const cVal = this.container.querySelector('.comp-val') as HTMLElement;
    cSlider.addEventListener('input', () => {
      const v = parseInt(cSlider.value, 10);
      cVal.textContent = v.toString();
      this.callbacks.onCompressionChange(v);
    });

    // View only
    const viewOnlyToggle = this.container.querySelector('.settings-view-only-toggle') as HTMLInputElement;
    viewOnlyToggle.checked = this.config.viewOnly;
    viewOnlyToggle.addEventListener('change', () => {
      this.config.viewOnly = viewOnlyToggle.checked;
      this.callbacks.onViewOnlyChange(viewOnlyToggle.checked);
    });

    // Scale mode
    const scaleSel = this.container.querySelector('.settings-scale-select') as HTMLSelectElement;
    scaleSel.value = this.config.scale;
    scaleSel.addEventListener('change', () => {
      this.callbacks.onScaleChange(scaleSel.value as ScaleMode);
    });

    // Audio: sample rate and mono/stereo are independent controls - both feed the same
    // callback, since the server's SetQuality always takes the pair together.
    const rateSel = this.container.querySelector('.settings-audio-rate-select') as HTMLSelectElement;
    const channelBtns = this.container.querySelectorAll('.audio-channel-btn');
    rateSel.value = this.config.audioSampleRate.toString();
    channelBtns.forEach((btn) => {
      const c = parseInt((btn as HTMLElement).dataset.channels || '0', 10);
      btn.classList.toggle('active', c === this.config.audioChannels);
    });

    const currentChannels = (): number => {
      const active = this.container.querySelector('.audio-channel-btn.active') as HTMLElement | null;
      return active ? parseInt(active.dataset.channels || '1', 10) : this.config.audioChannels;
    };

    rateSel.addEventListener('change', () => {
      this.callbacks.onAudioQualityChange(parseInt(rateSel.value, 10), currentChannels());
    });

    channelBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        channelBtns.forEach((b) => b.classList.toggle('active', b === btn));
        const channels = parseInt((btn as HTMLElement).dataset.channels || '1', 10);
        this.callbacks.onAudioQualityChange(parseInt(rateSel.value, 10), channels);
      });
    });

    // DPI scale: slider (snaps to quarter-steps while dragging) and a number box next to it
    // (freely typeable, any value in range) - kept in sync with each other both ways.
    const dpiSlider = this.container.querySelector('.dpi-slider') as HTMLInputElement;
    const dpiNumber = this.container.querySelector('.dpi-number') as HTMLInputElement;
    dpiSlider.value = this.config.dpiScale.toString();
    dpiNumber.value = this.config.dpiScale.toString();
    dpiSlider.addEventListener('input', () => {
      dpiNumber.value = dpiSlider.value;
      this.callbacks.onDpiChange(parseFloat(dpiSlider.value));
    });
    dpiNumber.addEventListener('input', () => {
      const v = parseFloat(dpiNumber.value);
      if (isNaN(v)) return;
      const clamped = Math.min(3, Math.max(0.5, v));
      dpiSlider.value = clamped.toString();
      this.callbacks.onDpiChange(clamped);
    });

    // Aspect ratio lock + common size presets + manual resolution (one-shot, any scale mode
    // except remote-resize - see updateModeVisibility)
    const widthInput = this.container.querySelector('.res-width-input') as HTMLInputElement;
    const heightInput = this.container.querySelector('.res-height-input') as HTMLInputElement;
    const applyBtn = this.container.querySelector('.res-apply-btn') as HTMLButtonElement;
    const autoBtn = this.container.querySelector('.res-auto-btn') as HTMLButtonElement;
    const ratioBtns = this.container.querySelectorAll('.ratio-btn');
    const presetBtns = this.container.querySelectorAll('.preset-btn');

    const roundEven = (n: number) => Math.max(64, Math.round(n / 2) * 2);

    ratioBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedRatio = (btn as HTMLElement).dataset.ratio || 'free';
        ratioBtns.forEach((b) => b.classList.toggle('active', b === btn));

        const ratio = this.getRatio(this.selectedRatio);
        const h = parseInt(heightInput.value, 10);
        if (ratio && Number.isInteger(h) && h > 0) {
          widthInput.value = roundEven((h * ratio[0]) / ratio[1]).toString();
        }
      });
    });

    presetBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const heightAttr = (btn as HTMLElement).dataset.height || '';
        // Same as every other preset here (720p/1080p/etc.) - just a height, with width derived
        // from whatever ratio is currently selected. Previously this set both inputs directly
        // from the window's raw size, which silently ignored the active ratio button (so e.g.
        // "16:9" could stay shown as selected while the fields no longer actually were).
        const h = heightAttr === 'window' ? roundEven(window.innerHeight) : parseInt(heightAttr, 10);
        if (!h) return;
        heightInput.value = h.toString();
        const ratio = this.getRatio(this.selectedRatio);
        if (ratio) {
          widthInput.value = roundEven((h * ratio[0]) / ratio[1]).toString();
        }
        // Show which common size is now in effect, same as the ratio-btn group above - stays
        // shown until the fields are changed some other way (typed directly, or Fit to Window),
        // since at that point the values no longer necessarily match this preset.
        presetBtns.forEach((b) => b.classList.toggle('active', b === btn));
      });
    });

    // Only a real keystroke/paste fires 'input' - a preset button or ratio-lock setting
    // .value programmatically does not - so this is exactly "the user edited it by hand",
    // which is when a preset's active highlight should stop claiming to describe the fields.
    widthInput.addEventListener('input', () => {
      presetBtns.forEach((b) => b.classList.remove('active'));
      const ratio = this.getRatio(this.selectedRatio);
      const w = parseInt(widthInput.value, 10);
      if (ratio && Number.isInteger(w) && w > 0) {
        heightInput.value = roundEven((w * ratio[1]) / ratio[0]).toString();
      }
    });

    heightInput.addEventListener('input', () => {
      presetBtns.forEach((b) => b.classList.remove('active'));
      const ratio = this.getRatio(this.selectedRatio);
      const h = parseInt(heightInput.value, 10);
      if (ratio && Number.isInteger(h) && h > 0) {
        widthInput.value = roundEven((h * ratio[0]) / ratio[1]).toString();
      }
    });

    applyBtn.addEventListener('click', () => {
      const w = parseInt(widthInput.value, 10);
      const h = parseInt(heightInput.value, 10);
      if (Number.isInteger(w) && Number.isInteger(h) && w >= 64 && h >= 64) {
        this.callbacks.onRequestResolution?.(w, h);
      }
    });
    autoBtn.addEventListener('click', () => {
      widthInput.value = '';
      heightInput.value = '';
      presetBtns.forEach((b) => b.classList.remove('active'));
      this.callbacks.onRequestWindowFitResolution?.();
    });

    // Close when clicking background backdrop
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) {
        this.close();
      }
    });
  }
}

