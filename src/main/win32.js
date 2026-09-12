'use strict'
/**
 * Native Win32 layer.
 *
 * Everything here is the stuff Electron cannot do on its own on Windows 10:
 *   - real backdrop blur behind a transparent window (Win10 has no Mica/acrylic backdrop API)
 *   - clipping the window to a rounded rect so the blur does not bleed past the CSS corners
 *   - forcing WS_EX_NOACTIVATE / WS_EX_TOOLWINDOW so the overlay never steals focus
 *   - synthesizing keystrokes into whatever window currently has focus
 *
 * If koffi fails to load for any reason we degrade to a no-op and the app still runs
 * with designed (non-blurred) glass. Nothing in here is allowed to be fatal.
 */

const os = require('os')

let koffi = null
let available = false
let loadError = null

let user32 = null
let gdi32 = null

// --- fn handles -------------------------------------------------------------
let SetWindowCompositionAttribute = null
let GetWindowLongPtr = null
let SetWindowLongPtr = null
let SetWindowPos = null
let CreateRoundRectRgn = null
let SetWindowRgn = null
let GetForegroundWindow = null
let SetForegroundWindow = null
let GetWindowThreadProcessId = null
let AttachThreadInput = null
let GetCurrentThreadId = null
let SendInput = null
let GetWindowTextW = null
let GetClassNameW = null
let MapVirtualKeyW = null
let GetWindowRect = null
let GetAsyncKeyState = null

// --- struct types -----------------------------------------------------------
let ACCENT_POLICY = null
let WINDOWCOMPOSITIONATTRIBDATA = null
let INPUT = null

// --- constants --------------------------------------------------------------
const WCA_ACCENT_POLICY = 19

const ACCENT = {
  DISABLED: 0,
  ENABLE_GRADIENT: 1,
  ENABLE_TRANSPARENTGRADIENT: 2,
  ENABLE_BLURBEHIND: 3, // the one that actually works well on Win10
  ENABLE_ACRYLICBLURBEHIND: 4, // Win10 1803+ but has the notorious drag-lag bug
  ENABLE_HOSTBACKDROP: 5,
}

const GWL_EXSTYLE = -20
const WS_EX_NOACTIVATE = 0x08000000
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_TRANSPARENT = 0x00000020
const WS_EX_LAYERED = 0x00080000

const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020

const INPUT_KEYBOARD = 1
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004
const KEYEVENTF_SCANCODE = 0x0008

const VK = {
  CONTROL: 0x11,
  SHIFT: 0x10,
  MENU: 0x12, // alt
  LWIN: 0x5b,
  RWIN: 0x5c,
  V: 0x56,
  RETURN: 0x0d,
}

function init() {
  if (available || loadError) return available
  if (os.platform() !== 'win32') {
    loadError = new Error('not windows')
    return false
  }
  try {
    koffi = require('koffi')

    user32 = koffi.load('user32.dll')
    gdi32 = koffi.load('gdi32.dll')

    ACCENT_POLICY = koffi.struct('ACCENT_POLICY', {
      AccentState: 'uint32',
      AccentFlags: 'uint32',
      GradientColor: 'uint32',
      AnimationId: 'uint32',
    })

    WINDOWCOMPOSITIONATTRIBDATA = koffi.struct('WINDOWCOMPOSITIONATTRIBDATA', {
      Attrib: 'uint32',
      pvData: 'void *',
      cbData: 'intptr',
    })

    // x64 layout: DWORD type + 4 bytes padding + 32-byte union.
    // KEYBDINPUT is 24 bytes, so 8 bytes of union tail padding follow it.
    const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uint64',
    })

    INPUT = koffi.struct('INPUT', {
      type: 'uint32',
      _pad0: 'uint32',
      ki: KEYBDINPUT,
      _pad1: koffi.array('uint8', 8),
    })

    const inputSize = koffi.sizeof(INPUT)
    if (inputSize !== 40) {
      // If this ever trips, SendInput would silently fail (it validates cbSize).
      throw new Error(`INPUT struct is ${inputSize} bytes, expected 40`)
    }

    // HWND/HRGN are passed as intptr so we can hand koffi a plain JS number.
    SetWindowCompositionAttribute = user32.func(
      'int __stdcall SetWindowCompositionAttribute(intptr hwnd, WINDOWCOMPOSITIONATTRIBDATA *data)'
    )
    GetWindowLongPtr = user32.func('int64 __stdcall GetWindowLongPtrW(intptr hwnd, int index)')
    SetWindowLongPtr = user32.func('int64 __stdcall SetWindowLongPtrW(intptr hwnd, int index, int64 value)')
    SetWindowPos = user32.func(
      'int __stdcall SetWindowPos(intptr hwnd, intptr after, int x, int y, int cx, int cy, uint32 flags)'
    )
    CreateRoundRectRgn = gdi32.func(
      'intptr __stdcall CreateRoundRectRgn(int l, int t, int r, int b, int w, int h)'
    )
    SetWindowRgn = user32.func('int __stdcall SetWindowRgn(intptr hwnd, intptr rgn, int redraw)')
    GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()')
    SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr hwnd)')
    GetWindowThreadProcessId = user32.func(
      'uint32 __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32 *pid)'
    )
    AttachThreadInput = user32.func('int __stdcall AttachThreadInput(uint32 a, uint32 b, int attach)')
    GetCurrentThreadId = koffi.load('kernel32.dll').func('uint32 __stdcall GetCurrentThreadId()')
    SendInput = user32.func('uint32 __stdcall SendInput(uint32 n, INPUT *inputs, int size)')
    GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr hwnd, _Out_ uint16 *buf, int max)')
    GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr hwnd, _Out_ uint16 *buf, int max)')
    MapVirtualKeyW = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 code, uint32 mapType)')
    GetWindowRect = user32.func('int __stdcall GetWindowRect(intptr hwnd, _Out_ void *rect)')
    GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vk)')

    available = true
  } catch (err) {
    loadError = err
    available = false
  }
  return available
}

/** Electron hands back the HWND as an 8-byte buffer; we want it as a number. */
function hwndOf(win) {
  try {
    const buf = win.getNativeWindowHandle()
    return buf.length === 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0)
  } catch {
    return 0
  }
}

/**
 * Turn on real backdrop blur for a window.
 *
 * tint is #rrggbb plus an alpha 0..1. Windows wants AABBGGRR, which is the
 * reverse byte order of what everyone expects, hence the shuffle.
 */
function applyBlur(win, { tint = '#0d0f12', alpha = 0.58, acrylic = false } = {}) {
  if (!init()) return false
  const hwnd = hwndOf(win)
  if (!hwnd) return false

  const hex = tint.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  const gradientColor = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0

  try {
    const policy = koffi.alloc(ACCENT_POLICY, 1)
    koffi.encode(policy, ACCENT_POLICY, {
      AccentState: acrylic ? ACCENT.ENABLE_ACRYLICBLURBEHIND : ACCENT.ENABLE_BLURBEHIND,
      AccentFlags: 2,
      GradientColor: gradientColor,
      AnimationId: 0,
    })
    const ok = SetWindowCompositionAttribute(hwnd, {
      Attrib: WCA_ACCENT_POLICY,
      pvData: policy,
      cbData: koffi.sizeof(ACCENT_POLICY),
    })
    return ok !== 0
  } catch {
    return false
  }
}

function clearBlur(win) {
  if (!init()) return false
  const hwnd = hwndOf(win)
  if (!hwnd) return false
  try {
    const policy = koffi.alloc(ACCENT_POLICY, 1)
    koffi.encode(policy, ACCENT_POLICY, {
      AccentState: ACCENT.DISABLED,
      AccentFlags: 0,
      GradientColor: 0,
      AnimationId: 0,
    })
    SetWindowCompositionAttribute(hwnd, {
      Attrib: WCA_ACCENT_POLICY,
      pvData: policy,
      cbData: koffi.sizeof(ACCENT_POLICY),
    })
    return true
  } catch {
    return false
  }
}

/**
 * The blur above fills the whole window rectangle, so without this the blur
 * squares off behind the CSS rounded corners. Clipping the window region to a
 * matching round rect is the only real fix on Win10.
 *
 * Sizes are physical pixels, so callers must multiply by the display scale factor.
 */
function applyRoundedRegion(win, { width, height, radius }) {
  if (!init()) return false
  const hwnd = hwndOf(win)
  if (!hwnd) return false
  try {
    // +1 on right/bottom: CreateRoundRectRgn's lower-right is exclusive.
    const rgn = CreateRoundRectRgn(0, 0, Math.round(width) + 1, Math.round(height) + 1, Math.round(radius) * 2, Math.round(radius) * 2)
    if (!rgn) return false
    SetWindowRgn(hwnd, rgn, 1) // window owns the region now, do not delete it
    return true
  } catch {
    return false
  }
}

/**
 * Place a window at an exact physical rect.
 *
 * This exists because Electron's own setBounds() clamps a frameless window to a
 * 64px minimum height on Windows 10, it reports the size you asked for while the
 * real HWND stays 64 tall. That matters more than cosmetics: DWM applies the
 * backdrop blur to the WINDOW RECT and ignores SetWindowRgn, so any window taller
 * than its glass paints a blurred rectangle below the rounded pane.
 *
 * SetWindowPos goes straight to the OS and honours sizes down to ~39px.
 */
function setExactBounds(win, { x, y, width, height }) {
  if (!init()) return false
  const hwnd = hwndOf(win)
  if (!hwnd) return false
  try {
    // SWP_NOZORDER | SWP_NOACTIVATE
    SetWindowPos(hwnd, 0, Math.round(x), Math.round(y), Math.round(width), Math.round(height), SWP_NOZORDER | SWP_NOACTIVATE)
    return true
  } catch {
    return false
  }
}

/** What the OS actually gave us, which is not always what we asked for. */
function getRealBounds(win) {
  if (!init()) return null
  const hwnd = hwndOf(win)
  if (!hwnd) return null
  try {
    const buf = Buffer.alloc(16)
    GetWindowRect(hwnd, buf)
    return {
      x: buf.readInt32LE(0),
      y: buf.readInt32LE(4),
      width: buf.readInt32LE(8) - buf.readInt32LE(0),
      height: buf.readInt32LE(12) - buf.readInt32LE(4),
    }
  } catch {
    return null
  }
}

function clearRegion(win) {
  if (!init()) return false
  const hwnd = hwndOf(win)
  if (!hwnd) return false
  try {
    SetWindowRgn(hwnd, 0, 1)
    return true
  } catch {
    return false
  }
}

/**
 * Make a window incapable of taking foreground focus.
 *
 * Electron's `focusable: false` sets this too, but it also blocks mouse input in
 * some configurations, so we set the bits ourselves and keep the window clickable.
 */
function setNoActivate(win, { toolWindow = true } = {}) {
  if (!init()) return false
  const hwnd = hwndOf(win)
  if (!hwnd) return false
  try {
    let ex = Number(GetWindowLongPtr(hwnd, GWL_EXSTYLE))
    ex |= WS_EX_NOACTIVATE
    if (toolWindow) ex |= WS_EX_TOOLWINDOW
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, BigInt(ex >>> 0))
    SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED)
    return true
  } catch {
    return false
  }
}

/**
 * Re-insert the window at the FRONT of the topmost band.
 *
 * Electron's setAlwaysOnTop only sets the flag, and re-calling it when the flag is
 * already true is a no-op. That isn't enough: other always-on-top applications
 * (Cursor sets WS_EX_TOPMOST on its main window) rank above us the moment they are
 * activated, and our overlay silently disappears behind them. Only an explicit
 * SetWindowPos(HWND_TOPMOST) puts it back on top, and SWP_NOACTIVATE keeps it from
 * stealing focus while doing so.
 */
function raiseTopmost(win) {
  if (!init()) return false
  const hwnd = hwndOf(win)
  if (!hwnd) return false
  try {
    const HWND_TOPMOST = -1
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    return true
  } catch {
    return false
  }
}

function wideStringFrom(fn, hwnd, max = 512) {
  try {
    const buf = Buffer.alloc(max * 2)
    const n = fn(hwnd, buf, max)
    if (n <= 0) return ''
    return buf.toString('ucs2', 0, n * 2).replace(/\0.*$/, '')
  } catch {
    return ''
  }
}

/** Who is the user actually typing into right now? */
function getForegroundInfo() {
  if (!init()) return null
  try {
    const hwnd = Number(GetForegroundWindow())
    if (!hwnd) return null
    return {
      hwnd,
      title: wideStringFrom(GetWindowTextW, hwnd),
      className: wideStringFrom(GetClassNameW, hwnd, 256),
    }
  } catch {
    return null
  }
}

function focusWindow(hwnd) {
  if (!init() || !hwnd) return false
  try {
    // SetForegroundWindow is refused unless our thread is attached to the target's.
    const targetThread = GetWindowThreadProcessId(hwnd, [0])
    const ourThread = GetCurrentThreadId()
    let attached = false
    if (targetThread && targetThread !== ourThread) {
      attached = AttachThreadInput(ourThread, targetThread, 1) !== 0
    }
    const ok = SetForegroundWindow(hwnd) !== 0
    if (attached) AttachThreadInput(ourThread, targetThread, 0)
    return ok
  } catch {
    return false
  }
}

function makeKeyInput(vk, up, unicode = false) {
  const scan = unicode ? vk : (() => { try { return MapVirtualKeyW(vk, 0) } catch { return 0 } })()
  return {
    type: INPUT_KEYBOARD,
    _pad0: 0,
    ki: {
      wVk: unicode ? 0 : vk,
      wScan: scan,
      dwFlags: (unicode ? KEYEVENTF_UNICODE : 0) | (up ? KEYEVENTF_KEYUP : 0),
      time: 0,
      dwExtraInfo: 0n,
    },
    _pad1: [0, 0, 0, 0, 0, 0, 0, 0],
  }
}

function send(inputs) {
  if (!inputs.length) return 0
  return SendInput(inputs.length, inputs, koffi.sizeof(INPUT))
}

/**
 * Release any modifier the user might physically be holding.
 *
 * Without this, a hotkey like Ctrl+Shift+Space that is still held when we fire
 * Ctrl+V turns into Ctrl+Shift+V, which pastes differently (or not at all).
 */
function releaseModifiers() {
  if (!init()) return
  try {
    // Only release what is genuinely held. Sending a key-UP for a modifier that was
    // never pressed is not harmless: a lone Alt-up activates the window menu and can
    // raise the task switcher, which then steals the foreground window we were
    // about to paste into. Observed doing exactly that during injection testing.
    const seq = []
    for (const vk of [VK.CONTROL, VK.SHIFT, VK.MENU, VK.LWIN, VK.RWIN]) {
      if (isKeyDown(vk)) seq.push(makeKeyInput(vk, true))
    }
    if (seq.length) send(seq)
  } catch {
    /* best effort */
  }
}

/** True when the key is physically down right now (high-order bit of the state). */
function isKeyDown(vk) {
  if (!init()) return false
  try {
    return (GetAsyncKeyState(vk) & 0x8000) !== 0
  } catch {
    return false
  }
}

/** Ctrl+V into whatever has focus. */
function sendPaste({ shift = false } = {}) {
  if (!init()) return false
  try {
    const seq = []
    seq.push(makeKeyInput(VK.CONTROL, false))
    if (shift) seq.push(makeKeyInput(VK.SHIFT, false))
    seq.push(makeKeyInput(VK.V, false))
    seq.push(makeKeyInput(VK.V, true))
    if (shift) seq.push(makeKeyInput(VK.SHIFT, true))
    seq.push(makeKeyInput(VK.CONTROL, true))
    return send(seq) === seq.length
  } catch {
    return false
  }
}

/**
 * Shift+Insert, the paste chord for mintty and classic conhost, where Ctrl+V is
 * simply not bound and fails silently.
 */
function sendShiftInsert() {
  if (!init()) return false
  try {
    const VK_INSERT = 0x2d
    const seq = [
      makeKeyInput(VK.SHIFT, false),
      makeKeyInput(VK_INSERT, false),
      makeKeyInput(VK_INSERT, true),
      makeKeyInput(VK.SHIFT, true),
    ]
    return send(seq) === seq.length
  } catch {
    return false
  }
}

function sendEnter() {
  if (!init()) return false
  try {
    return send([makeKeyInput(VK.RETURN, false), makeKeyInput(VK.RETURN, true)]) === 2
  } catch {
    return false
  }
}

/**
 * Type text one UTF-16 unit at a time. Slower and it trips over some TUIs, but it
 * leaves the clipboard untouched, so it is the fallback when clipboard paste fails.
 */
function sendUnicodeText(text) {
  if (!init()) return false
  try {
    const CHUNK = 40
    const units = []
    for (let i = 0; i < text.length; i++) units.push(text.charCodeAt(i))
    for (let i = 0; i < units.length; i += CHUNK) {
      const slice = units.slice(i, i + CHUNK)
      const seq = []
      for (const u of slice) {
        seq.push(makeKeyInput(u, false, true))
        seq.push(makeKeyInput(u, true, true))
      }
      if (send(seq) !== seq.length) return false
    }
    return true
  } catch {
    return false
  }
}

module.exports = {
  init,
  get available() {
    return available
  },
  get loadError() {
    return loadError
  },
  hwndOf,
  applyBlur,
  clearBlur,
  applyRoundedRegion,
  setExactBounds,
  getRealBounds,
  clearRegion,
  setNoActivate,
  raiseTopmost,
  getForegroundInfo,
  focusWindow,
  releaseModifiers,
  isKeyDown,
  sendPaste,
  sendShiftInsert,
  sendEnter,
  sendUnicodeText,
  ACCENT,
}
