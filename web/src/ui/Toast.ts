export type ToastLevel = 'error' | 'warning' | 'info';

export interface ToastOptions {
  level?: ToastLevel;
  // ms until auto-dismiss. Errors default to persistent (0 - stays until closed manually,
  // since the whole point is that connection/auth failures were previously easy to miss);
  // warning/info default to a few seconds.
  autoDismissMs?: number;
}

// General-purpose bottom-right notification stack. Anything that was previously only a
// console.log/console.warn or a hover-tooltip-only status message (connection lost, auth
// failed, audio errors, etc.) can go through here instead, so it's actually visible.
export class ToastHost {
  private container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.className = 'toast-host';
  }

  public show(message: string, options: ToastOptions = {}): void {
    const level = options.level ?? 'info';
    const autoDismissMs = options.autoDismissMs ?? (level === 'error' ? 0 : 5000);

    const toastEl = document.createElement('div');
    toastEl.className = `toast toast-${level}`;
    toastEl.innerHTML = `
      <span class="toast-msg"></span>
      <button class="toast-close-btn" title="Dismiss">&times;</button>
    `;
    (toastEl.querySelector('.toast-msg') as HTMLElement).textContent = message;

    let dismissTimer: number | null = null;
    const dismiss = () => {
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      toastEl.classList.remove('toast-visible');
      // Matches the CSS transition duration - removed after it finishes fading/sliding out.
      window.setTimeout(() => toastEl.remove(), 200);
    };

    (toastEl.querySelector('.toast-close-btn') as HTMLElement).addEventListener('click', dismiss);

    this.container.appendChild(toastEl);
    // Next frame, so the initial state actually transitions in rather than snapping.
    requestAnimationFrame(() => toastEl.classList.add('toast-visible'));

    if (autoDismissMs > 0) {
      dismissTimer = window.setTimeout(dismiss, autoDismissMs);
    }
  }
}
