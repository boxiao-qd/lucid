// CDP input construction — ported from zcode browserCommandInput.ts.
// Mouse click, key press, scroll gesture via CDP Input domain.

import type { BrowserKeyModifier, BrowserMouseButton } from '../../shared/browser-use'
import type { BrowserPoint, ControlledView } from '../../shared/browser-use'
import { RESOLVE_SCRIPT } from './command-scripts'

const MODIFIER_BITS: Record<BrowserKeyModifier, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === 'darwin' ? 4 : 2,
  Meta: 4,
  Shift: 8
}

const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }
}

const MODIFIER_KEY_MAP: Record<
  BrowserKeyModifier,
  { code: string; windowsVirtualKeyCode: number }
> = {
  Alt: { code: 'AltLeft', windowsVirtualKeyCode: 18 },
  Control: { code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  ControlOrMeta:
    process.platform === 'darwin'
      ? { code: 'MetaLeft', windowsVirtualKeyCode: 91 }
      : { code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  Meta: { code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  Shift: { code: 'ShiftLeft', windowsVirtualKeyCode: 16 }
}

// Suppress unused warning — MODIFIER_KEY_MAP is retained for potential
// future keypress/combo support (dispatchKeyPress) and documents the
// CDP key code mapping for modifier keys.
void MODIFIER_KEY_MAP

export function modifiersBitmask(mods?: readonly BrowserKeyModifier[]): number {
  if (!mods || mods.length === 0) return 0
  let bits = 0
  for (const m of mods) bits |= MODIFIER_BITS[m]
  return bits
}

/** Resolve ref element center: inject RESOLVE_SCRIPT, return {cx, cy} or null. */
export async function resolveRefCenter(
  view: ControlledView,
  ref: string
): Promise<BrowserPoint | null> {
  const raw = (await view.webContents.executeJavaScript(RESOLVE_SCRIPT(ref))) as {
    cx?: unknown
    cy?: unknown
  } | null
  if (!raw || typeof raw.cx !== 'number' || typeof raw.cy !== 'number') return null
  return { cx: raw.cx, cy: raw.cy }
}

/** CDP real mouse click: mouseMoved → mousePressed → mouseReleased. */
export async function dispatchClickAt(
  view: ControlledView,
  center: BrowserPoint,
  button: BrowserMouseButton,
  doubleClick: boolean,
  modifiers = 0
): Promise<void> {
  const clickCount = doubleClick ? 2 : 1
  const mod = modifiers > 0 ? { modifiers } : {}
  await view.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: center.cx,
    y: center.cy,
    ...mod
  })
  await view.cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod
  })
  await view.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: center.cx,
    y: center.cy,
    button,
    clickCount,
    ...mod
  })
}

/** CDP key press: keyDown + keyUp. */
export async function dispatchKey(
  view: ControlledView,
  keyName: string,
  modifiers = 0
): Promise<void> {
  const def = KEY_MAP[keyName]
  const base = def
    ? { key: def.key, code: def.code, windowsVirtualKeyCode: def.windowsVirtualKeyCode }
    : { key: keyName }
  const mod = modifiers > 0 ? { modifiers } : {}
  await view.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...mod })
  await view.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base, ...mod })
}

/** CDP scroll: move to anchor, then dispatch mouseWheel. */
export async function dispatchScrollGesture(
  view: ControlledView,
  point: BrowserPoint,
  scrollX: number,
  scrollY: number,
  modifiers = 0
): Promise<void> {
  const mod = modifiers > 0 ? { modifiers } : {}
  await view.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.cx,
    y: point.cy,
    ...mod
  })
  await view.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: point.cx,
    y: point.cy,
    deltaX: scrollX,
    deltaY: scrollY,
    ...mod
  })
}
