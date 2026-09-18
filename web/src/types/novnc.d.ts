declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: any);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    dragViewport: boolean;
    qualityLevel: number;
    compressionLevel: number;
    showDotCursor: boolean;
    background: string;
    disconnect(): void;
    sendCredentials(creds: { password?: string; username?: string }): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    _fbWidth: number;
    _fbHeight: number;
  }
}
