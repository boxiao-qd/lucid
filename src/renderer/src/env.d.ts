/// <reference types="vite/client" />

// Electron <webview> tag — JSX intrinsic element declaration
declare global {
  interface WebviewTag extends HTMLElement {
    src: string
    partition: string
    getWebContentsId(): number
    addEventListener(type: string, listener: (this: HTMLElement, ev: Event) => void): void
    removeEventListener(type: string, listener: (this: HTMLElement, ev: Event) => void): void
  }
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<WebviewTag> & {
          src?: string
          partition?: string
          webpreferences?: string
        },
        WebviewTag
      >
    }
  }
}
