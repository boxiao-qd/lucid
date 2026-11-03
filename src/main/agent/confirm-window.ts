// System-wide confirmation overlay window.
//
// Creates a frameless, alwaysOnTop BrowserWindow positioned at the top-right
// corner of the screen. The window loads confirm.html → confirm.tsx →
// ConfirmOverlay, and receives confirmation data via the 'confirm:data' IPC
// event. When the user responds (approve/reject), the overlay calls
// window.api.confirm.respond() → resolveConfirmation() → closeConfirmWindow().
//
// This bypasses the renderer's isCurrent guard entirely — the notification
// appears regardless of which lucid page the user is on, and thanks to
// alwaysOnTop, even when the user is in another app.

import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type { ToolConfirmChoice, ToolConfirmCommandBlock } from '../../shared/agent-events'

export interface ConfirmWindowData {
  confirmationId: string
  sessionId: string
  toolName: string
  content: string
  choices?: ToolConfirmChoice[]
  commandBlocks?: ToolConfirmCommandBlock[]
  purpose?: string
}

let confirmWindow: BrowserWindow | null = null

export function showConfirmWindow(data: ConfirmWindowData): void {
  // If a window already exists (e.g. previous confirmation timed out but
  // window wasn't closed yet), close it before creating a new one.
  if (confirmWindow && !confirmWindow.isDestroyed()) {
    confirmWindow.close()
  }

  const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize
  const windowWidth = 420

  confirmWindow = new BrowserWindow({
    width: windowWidth,
    height: 360,
    x: screenWidth - windowWidth - 20, // 20px margin from right edge
    y: 40, // 40px from top
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false, // show after did-finish-load via showInactive
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Dev: load from Vite dev server; Prod: load built HTML file.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    confirmWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/confirm.html`)
  } else {
    confirmWindow.loadFile(join(__dirname, '../renderer/confirm.html'))
  }

  // Send confirmation data once the page is ready
  confirmWindow.webContents.on('did-finish-load', () => {
    if (confirmWindow && !confirmWindow.isDestroyed()) {
      confirmWindow.webContents.send('confirm:data', data)
    }
  })

  // Clean up the reference when the window is closed (user clicked a button,
  // or closeConfirmWindow() was called).
  confirmWindow.on('closed', () => {
    confirmWindow = null
  })

  // showInactive: display the window without stealing focus from the current
  // app. The user can click on it when ready. alwaysOnTop keeps it visible
  // above other windows.
  confirmWindow.showInactive()
}

export function closeConfirmWindow(): void {
  if (confirmWindow && !confirmWindow.isDestroyed()) {
    confirmWindow.close()
  }
  confirmWindow = null
}

// Allow the renderer to resize the frameless window to match its content height.
// This eliminates any blank space below the action buttons when the content
// (purpose, commands list, etc.) is shorter than the initial 360px default.
ipcMain.on('confirm:resize', (_event, height: number) => {
  if (confirmWindow && !confirmWindow.isDestroyed()) {
    const { height: screenHeight } = screen.getPrimaryDisplay().workAreaSize
    const windowWidth = 420
    // Clamp height to a reasonable range so it never overflows the screen.
    const finalHeight = Math.min(Math.max(Math.ceil(height), 100), Math.floor(screenHeight * 0.8))
    confirmWindow.setSize(windowWidth, finalHeight)
  }
})
