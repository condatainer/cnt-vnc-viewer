export class PasswordModal {
  private container: HTMLElement;
  private resolvePromise: ((pwd: string) => void) | null = null;
  private rejectPromise: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.className = 'modal-backdrop hidden';
    this.container.innerHTML = `
      <div class="modal-dialog auth-dialog">
        <div class="modal-header">
          <h3>VNC Authentication Required</h3>
        </div>
        <div class="modal-body">
          <p>Please enter the VNC server password:</p>
          <p class="auth-error-msg hidden"></p>
          <p class="auth-status-msg hidden">Verifying...</p>
          <input type="password" class="auth-password-input" placeholder="Password" autofocus autocomplete="current-password" />
        </div>
        <div class="modal-footer">
          <button class="action-btn auth-cancel-btn">Cancel</button>
          <button class="action-btn auth-submit-btn">Login</button>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  // errorMessage is set when this is a re-prompt after a failed attempt (e.g. wrong password) -
  // shown inline so the reason is actually visible, not just logged to the console. Also used
  // to bring the dialog back out of the "Verifying..." state left by a previous submit() - see
  // submit()/close() for why the dialog no longer closes on submit.
  public prompt(errorMessage?: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
      this.container.classList.remove('hidden');

      const errorEl = this.container.querySelector('.auth-error-msg') as HTMLElement;
      errorEl.textContent = errorMessage || '';
      errorEl.classList.toggle('hidden', !errorMessage);

      const statusEl = this.container.querySelector('.auth-status-msg') as HTMLElement;
      statusEl.classList.add('hidden');

      const input = this.container.querySelector('.auth-password-input') as HTMLInputElement;
      const submitBtn = this.container.querySelector('.auth-submit-btn') as HTMLButtonElement;
      input.disabled = false;
      submitBtn.disabled = false;
      input.value = '';
      setTimeout(() => input.focus(), 50);
    });
  }

  // Closes the dialog outright - used once the caller knows the outcome for certain (a
  // successful connection). Safe to call when nothing is open.
  public close(): void {
    this.container.classList.add('hidden');
    this.resolvePromise = null;
    this.rejectPromise = null;
  }

  private submit(): void {
    const input = this.container.querySelector('.auth-password-input') as HTMLInputElement;
    const submitBtn = this.container.querySelector('.auth-submit-btn') as HTMLButtonElement;
    const pwd = input.value;

    // Deliberately does NOT hide the dialog here - a VNC auth failure closes the connection
    // outright (no "retry on the same socket"), so finding out whether this password was right
    // means tearing down and reconnecting. Closing the dialog now and waiting for that round
    // trip to reopen it made it look like the dialog had just quit rather than let you retry.
    // Instead it stays open in a disabled "Verifying..." state until either a fresh
    // credentialsrequired re-prompts it (wrong password - see prompt()) or close() is called
    // (right password - see main.ts's 'connected' handling).
    input.disabled = true;
    submitBtn.disabled = true;
    const errorEl = this.container.querySelector('.auth-error-msg') as HTMLElement;
    errorEl.classList.add('hidden');
    const statusEl = this.container.querySelector('.auth-status-msg') as HTMLElement;
    statusEl.classList.remove('hidden');

    if (this.resolvePromise) {
      this.resolvePromise(pwd);
      this.resolvePromise = null;
    }
  }

  private cancel(): void {
    const reject = this.rejectPromise;
    this.close();
    if (reject) {
      reject();
    }
  }

  private bindEvents(): void {
    const input = this.container.querySelector('.auth-password-input') as HTMLInputElement;
    const submitBtn = this.container.querySelector('.auth-submit-btn')!;
    const cancelBtn = this.container.querySelector('.auth-cancel-btn')!;

    submitBtn.addEventListener('click', () => this.submit());
    cancelBtn.addEventListener('click', () => this.cancel());

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.submit();
      } else if (e.key === 'Escape') {
        this.cancel();
      }
    });
  }
}

