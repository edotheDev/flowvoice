'use strict'

const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, shell, nativeImage } = require('electron')

const win32 = require('./win32')
const { Config } = require('./config')
const { Transcriber } = require('./stt')
const { Corrector } = require('./correct')
const { Lexicon } = require('./lexicon')
const { MemoStore } = require('./memos')
const { Corpus } = require('./corpus')
const { insertText } = require('./inject')

// NOTE: no --enable-transparent-visuals here. It is a Linux/X11 workaround; on
// Windows 10 it took the renderer process down with it (`render-process-gone:
// crashed`, nothing on screen but the DWM tint). Windows composites transparent
// Electron windows correctly without any switch.
// Likewise no --disable-gpu-vsync: appendSwitch with 'false' still *sets* the flag,
// since Chromium only checks for presence.

const single = app.requestSingleInstanceLock()
if (!single) app.quit()

/**
 * The pill is a FIXED-SIZE window that stays put; every visual state change is done
 * in CSS inside it.
 *
 * This fixes two things at once. Windows floors a frameless window at 64px and
 * resizing it per state fought Chromium's viewport; and DWM paints any acrylic blur
 * to the window RECTANGLE while ignoring SetWindowRgn. With the window genuinely
 * transparent wherever CSS doesn't paint, the visible shape can be any size or
 * radius, including a 4px idle sliver, with clean antialiased edges, and it can
 * morph smoothly instead of stepping window bounds frame by frame.
 */
const PILL_WIN = { w: 560, h: 132 }

const config = new Config()
let pillWin = null
let tray = null
let transcriber = null
let corrector = null
let lexicon = null
let memos = null
let corpus = null
let pillState = 'idle'
/** Window that had focus when recording began: the text's destination. */
let captureTarget = null
let escRegistered = false

/** Where anything the app writes on its own lives. Never inside the repo. */
function dataDir(...parts) {
  return path.join(app.getPath('userData'), ...parts)
}

/* ---------------------------------------------------------------- windows -- */

function makeOverlay({ width, height, name }) {
  const win = new BrowserWindow({
    width,
    height,
    // Windows floors a frameless window at ~64px tall unless the minimum is stated
    // explicitly.
    minWidth: 1,
    minHeight: 1,
    // NOT useContentSize. With it, Electron treats a natively-forced window size as
    // including a frame and shrinks the document to compensate. Frameless windows
    // have no frame to subtract, so window size == content size.
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never take foreground focus: the app underneath must keep the caret.
    focusable: false,
    acceptFirstMouse: true,
    // Hides it from Alt-Tab on Windows.
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  })

  // Surface renderer failures in the main log. A blocked stylesheet or a preload
  // error otherwise shows up only as an invisible window.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[${name}:renderer] ${message}  (${String(source).split('/').pop()}:${line})`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[${name}:renderer] failed to load ${url}: ${desc} (${code})`)
  })
  win.webContents.on('preload-error', (_e, p, err) => {
    console.error(`[${name}:preload] ${p}: ${err.message}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[${name}:renderer] gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })

  if (process.env.FLOWVOICE_DEBUG) {
    win.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        // capturePage() renders what the PAGE actually produced, independent of DWM
        // compositing: the only way to tell a layout bug apart from a blur artefact.
        win.webContents
          .capturePage()
          .then(img => {
            const out = dataDir(`page-${name}.png`)
            fs.writeFileSync(out, img.toPNG())
            console.log(`[${name}] page capture written to ${out}`)
          })
          .catch(e => console.error(`[${name}:capture] ${e.message}`))
      }, 4000)
    })
  }

  // Above normal always-on-top windows so it survives other floating tools.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.name = name
  return win
}

function place(win, rect) {
  if (!win || win.isDestroyed()) return
  win.setBounds(rect)
  win._rect = rect
  win32.setNoActivate(win)
  // Re-assert after every bounds change: setNoActivate rewrites GWL_EXSTYLE, and
  // other apps (installers, browser popups) claim topmost for themselves and can
  // leave the pill buried underneath.
  win.setAlwaysOnTop(true, 'screen-saver')
}

const VK_LBUTTON = 0x01

/** Active drag, or null. Set from the renderer's mousedown, cleared on button-up. */
let drag = null

function endDrag() {
  if (!drag) return
  const { win } = drag
  drag = null
  if (win.isDestroyed()) return
  win.webContents.send('drag:end')
  // Clamp so it can never be stranded off-screen.
  const r = clampToDisplays(win._rect)
  if (r.x !== win._rect.x || r.y !== win._rect.y) place(win, r)
}

/** Keep at least a corner of the window on some display. */
function clampToDisplays(rect) {
  const displays = screen.getAllDisplays()
  const margin = 40
  const visible = displays.some(d => {
    const a = d.workArea
    return (
      rect.x + rect.width > a.x + margin &&
      rect.x < a.x + a.width - margin &&
      rect.y + rect.height > a.y + margin &&
      rect.y < a.y + a.height - margin
    )
  })
  if (visible) return rect
  const a = screen.getPrimaryDisplay().workArea
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, a.x), a.x + a.width - rect.width),
    y: Math.min(Math.max(rect.y, a.y), a.y + a.height - rect.height),
  }
}

/**
 * Classes of the Alt-Tab / Task View switchers. Calling SetWindowPos while one of
 * these is up yanks the z-order out from under it and the switcher closes.
 */
const SWITCHER_CLASSES = [
  'multitaskingviewframe', // Task View / Alt-Tab on Win10
  'xamlexplorerhostislandwindow', // newer Alt-Tab host
  'taskswitcherwnd', // classic switcher
  'windowswitcherwnd',
  'foregroundstaging',
]

const VK_MENU = 0x12

function switcherActive() {
  // Alt physically held is the cheap signal, and covers the moment before the
  // switcher window even exists.
  if (win32.isKeyDown(VK_MENU)) return true
  const fg = win32.getForegroundInfo()
  if (!fg) return false
  const cls = (fg.className || '').toLowerCase()
  return SWITCHER_CLASSES.some(c => cls.includes(c))
}

/** Set on every foreground change; we stay out of the way until it settles. */
let lastForegroundChange = 0

/**
 * Re-claim the front of the topmost band, carefully.
 *
 * SetWindowPos during a window switch cancels the switch, so three guards: never
 * while Alt is held, never while a switcher window is foreground, and never within
 * 900ms of a foreground change.
 */
function keepOnTop() {
  if (!config.data.pill.keepOnTop) return
  if (switcherActive()) return
  if (Date.now() - lastForegroundChange < 900) return
  if (pillWin && !pillWin.isDestroyed()) win32.raiseTopmost(pillWin)
}

/**
 * The window is larger than the shape drawn inside it, so by default it lets clicks
 * pass straight through to whatever is underneath. Otherwise a 560x132 invisible
 * rectangle would eat clicks across the bottom of the screen.
 */
function setClickThrough(win, ignore) {
  if (!win || win.isDestroyed()) return
  if (win._ignoring === ignore) return
  win._ignoring = ignore
  win.setIgnoreMouseEvents(ignore, { forward: true })
}

/**
 * Feed the pill the cursor position in its own coordinate space.
 *
 * Electron's `forward: true` is supposed to keep mousemove flowing while a window
 * ignores mouse events, but it delivers nothing for a transparent `focusable: false`
 * window. So hover is driven from the global cursor instead. The renderer still does
 * the hit-testing, because only it knows where its painted shape currently is.
 */
function startPointerFeed() {
  let lastInside = false
  let lastForeground = 0
  setInterval(() => {
    let p
    try {
      p = screen.getCursorScreenPoint()
    } catch {
      return
    }

    // Note the focus change but do NOT raise here. Raising the instant focus moves
    // is what cancels Alt-Tab; keepOnTop waits out the settle window instead.
    const fg = win32.getForegroundInfo()
    if (fg && fg.hwnd !== lastForeground) {
      lastForeground = fg.hwnd
      lastForegroundChange = Date.now()
    }

    // A drag owns the cursor completely until the button comes back up.
    if (drag) {
      const x = p.x - drag.offsetX
      const y = p.y - drag.offsetY
      drag.win.setBounds({ x, y, width: drag.win._rect.width, height: drag.win._rect.height })
      drag.win._rect = { x, y, width: drag.win._rect.width, height: drag.win._rect.height }
      // The pointer leaves the window as soon as it moves, so DOM mouseup can't be
      // trusted to end the drag. Watch the physical button instead, and require two
      // consecutive up readings: GetAsyncKeyState can momentarily read up right after
      // the press.
      if (win32.isKeyDown(VK_LBUTTON)) drag.upTicks = 0
      else if (++drag.upTicks >= 2) endDrag()
      return
    }

    const win = pillWin
    if (!win || win.isDestroyed() || !win._rect) return
    const r = win._rect
    const inside = p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
    // Send one final out-of-bounds message so the page can drop its hover state.
    if (!inside && !lastInside) return
    lastInside = inside
    win.webContents.send('pointer', inside ? { x: p.x - r.x, y: p.y - r.y } : null)
  }, 60)
}

/** Bottom centre. CSS pins the pill to the bottom of the window and grows it upward. */
function pillAnchor() {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: Math.round(wa.x + (wa.width - PILL_WIN.w) / 2),
    y: wa.y + wa.height - PILL_WIN.h - config.data.pill.bottomMargin + 10,
    width: PILL_WIN.w,
    height: PILL_WIN.h,
  }
}

function createPillWindow() {
  pillWin = makeOverlay({ width: PILL_WIN.w, height: PILL_WIN.h, name: 'pill' })
  pillWin.loadFile(path.join(__dirname, '..', 'renderer', 'pill', 'index.html'))
  pillWin.once('ready-to-show', () => {
    pillWin.showInactive()
    place(pillWin, pillAnchor())
    setClickThrough(pillWin, true)
    pillWin.webContents.send('config', {
      hotkey: config.data.hotkey,
      autoInsert: config.data.pill.autoInsert !== false,
    })
    console.log(`[pill]  ${PILL_WIN.w}x${PILL_WIN.h} @ ${pillWin._rect.x},${pillWin._rect.y}`)
  })
}

/* ------------------------------------------------------------------ state -- */

function applyPillState(state) {
  pillState = state
  // The window never resizes; the pill's own size is a CSS transition. All main
  // still owns is whether clicks land on it and whether Esc is grabbed.
  if (state !== 'idle') setClickThrough(pillWin, false)

  // Esc only exists while there is something to cancel. Grabbing it globally at all
  // times would steal the key from every other app on the machine. Anything that
  // isn't idle counts, including `working` and `error`, which are exactly the states
  // a failed transcription can strand the pill in.
  const wantEsc = state !== 'idle'
  if (wantEsc && !escRegistered) {
    escRegistered = globalShortcut.register(config.data.cancelKey, () => {
      pillWin && pillWin.webContents.send('pill:command', 'cancel')
    })
  } else if (!wantEsc && escRegistered) {
    globalShortcut.unregister(config.data.cancelKey)
    escRegistered = false
  }
}

function onHotkey() {
  if (!pillWin) return
  // Remember where the text is going before anything else happens. The pill is
  // WS_EX_NOACTIVATE so focus shouldn't move, but capturing up front means a stray
  // click during a long dictation can't silently redirect the paste.
  if (pillState === 'idle') captureTarget = win32.getForegroundInfo()
  pillWin.webContents.send('pill:command', 'toggle')
}

/** Memo capture. No caret is involved, so no target to remember. */
function onMemoHotkey() {
  if (!pillWin) return
  pillWin.webContents.send('pill:command', 'memo')
}

/* -------------------------------------------------------------------- app -- */

app.whenReady().then(async () => {
  config.load()
  transcriber = new Transcriber(config.data)
  lexicon = new Lexicon().load()
  corrector = new Corrector(config.data, lexicon)
  memos = new MemoStore(config.data.memo.dir || dataDir('memos'))
  corpus = new Corpus(config.data.corpus.dir || dataDir('corpus'), { maxMB: config.data.corpus.maxMB })
  if (config.data.corpus.enabled) {
    const s = corpus.stats()
    console.log(`[corpus] ${s.utterances} utterance(s), ${s.clips} clip(s), ${s.mb.toFixed(1)}MB`)
  }

  if (config.data.pill.show) createPillWindow()

  const ok = globalShortcut.register(config.data.hotkey, onHotkey)
  if (!ok) console.error(`[hotkey] could not register ${config.data.hotkey}: already taken`)

  // Memo is a SEPARATE key, never a mode the dictation hotkey can fall into: mixing
  // them would mean a mis-press either eats a dictation or silently files one.
  if (config.data.memo.enabled) {
    const okMemo = globalShortcut.register(config.data.memo.hotkey, onMemoHotkey)
    if (!okMemo) {
      console.error(`[hotkey] could not register memo key ${config.data.memo.hotkey}: already taken`)
    } else {
      console.log(`[memo]   ${config.data.memo.hotkey} -> ${memos.dir}`)
    }
  }

  buildTray()
  startPointerFeed()

  // Other always-on-top apps can outrank the pill the moment they are activated, and
  // nothing notifies us, so we periodically claim the front of the topmost band back.
  setInterval(keepOnTop, 600)

  // init() is lazy, so `available` reads false until something first touches the
  // native layer. Force it here so a real failure is reported once, clearly.
  if (!win32.init()) {
    console.error('[win32] native layer unavailable:', win32.loadError && win32.loadError.message)
  }

  // A display change moves the work area under us; re-anchor the pill.
  screen.on('display-metrics-changed', reanchor)
  screen.on('display-added', reanchor)
  screen.on('display-removed', reanchor)
})

function reanchor() {
  if (pillWin && !pillWin.isDestroyed()) place(pillWin, pillAnchor())
}

function buildTray() {
  // 16px dot, drawn rather than shipped as a file so there's no asset to lose.
  const png = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' +
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="none" stroke="white" stroke-width="1.6"/><circle cx="8" cy="8" r="1.8" fill="white"/></svg>`
      ).toString('base64')
  )
  tray = new Tray(png.isEmpty() ? nativeImage.createEmpty() : png)
  tray.setToolTip('FlowVoice')
  refreshTrayMenu()
}

function refreshTrayMenu() {
  if (!tray) return
  const pendingMemos = memos ? memos.pending().length : 0
  const menu = Menu.buildFromTemplate([
    { label: `Voice: ${transcriber.describe()}`, enabled: false },
    { label: `Correction: ${corrector.describe()}`, enabled: false },
    { label: `Dictate: ${config.data.hotkey}`, enabled: false },
    {
      label: config.data.memo.enabled ? `Memo: ${config.data.memo.hotkey}` : 'Memo: off',
      enabled: false,
    },
    { type: 'separator' },
    {
      // The only thing that sends memo audio anywhere, and it never fires on its own.
      label: pendingMemos ? `Transcribe ${pendingMemos} memo${pendingMemos === 1 ? '' : 's'}` : 'No memos to transcribe',
      enabled: pendingMemos > 0,
      click: () => transcribeMemos(),
    },
    { label: 'Open memos folder…', click: () => shell.openPath(memos.dir) },
    {
      label: 'Voice pill',
      type: 'checkbox',
      checked: config.data.pill.show,
      click: item => {
        config.set({ pill: { show: item.checked } })
        if (item.checked) createPillWindow()
        else if (pillWin) (pillWin.destroy(), (pillWin = null))
      },
    },
    { type: 'separator' },
    { label: 'Edit settings…', click: () => shell.openPath(config.file) },
    // Worth opening by hand: it is sorted by frequency, so the top of the file is
    // exactly what this voice gets transcribed wrong most often.
    { label: `Voice lexicon… (${lexicon.size})`, click: () => shell.openPath(lexicon.file) },
    {
      label: 'Reload settings',
      click: () => {
        config.load()
        lexicon.load()
        transcriber = new Transcriber(config.data)
        corrector = new Corrector(config.data, lexicon)
        refreshTrayMenu()
        reanchor()
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

/* -------------------------------------------------------------------- ipc -- */

ipcMain.on('pill:state', (_e, state) => applyPillState(state))

// The renderer reports where inside its window the grab started; main takes over
// from there so the drag survives the cursor leaving the window.
ipcMain.on('drag:start', (e, offset) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win || win.isDestroyed() || !win._rect) return
  drag = { win, offsetX: offset.x, offsetY: offset.y, upTicks: 0 }
})

/**
 * The renderer knows where its own visible shape is; main doesn't. So the page says
 * when the pointer is actually over the pill and main makes the window clickable for
 * as long as that's true.
 */
ipcMain.on('overlay:interactive', (e, wants) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  // While the pill is mid-flow, keep it clickable regardless of hover so the confirm
  // target never slips out from under the cursor.
  if (win === pillWin && pillState !== 'idle') return setClickThrough(win, false)
  setClickThrough(win, !wants)
})

ipcMain.handle('pill:transcribe', async (_e, payload) => {
  const bytes = payload && payload.bytes
  if (!bytes || !bytes.length) return { ok: false, error: 'no audio' }
  try {
    console.log(`[stt] sending ${bytes.length}B (${payload.durationMs}ms)`)
    const res = await transcriber.transcribe(bytes)
    // The pill shows the provider's error for 2.6s and then wipes it. Logging it
    // here is the only durable record of *which* code came back.
    if (!res || !res.ok) {
      console.error('[stt]', (res && res.error) || 'unknown failure')
      if (res && res.detail) console.error('[stt] body:', res.detail)
      // Keep the exact bytes the provider rejected, for debugging. One fixed path,
      // overwritten each time, so this can never quietly accumulate recordings.
      try {
        const dump = dataDir('rejected-audio.webm')
        fs.writeFileSync(dump, Buffer.from(bytes))
        console.error('[stt] audio written to', dump)
      } catch (e) {
        console.error('[stt] could not write audio dump:', e.message)
      }
      return res
    }

    // Second pass. Never allowed to make the result worse: `fix` returns the input
    // untouched on every failure path, so a dead corrector just means raw Whisper.
    const fixed = await corrector.fix(res.text)
    if (fixed.error) console.error('[correct]', fixed.error)
    if (fixed.known && fixed.known.length) {
      console.log('[correct] known: ' + fixed.known.map(h => `"${h.from}" -> "${h.to}"`).join(', '))
    }
    if (fixed.changed) {
      // Diff the MODEL's contribution only: learnFrom is the text after the
      // deterministic lookup ran, so known fixes aren't re-learned every time.
      const { learned, skipped } = lexicon.learnFromDiff(fixed.learnFrom ?? res.text, fixed.learnTo ?? fixed.text, {
        anchors: config.data.correction.glossary,
      })
      const show = list => list.map(p => `"${p.from}" -> "${p.to}"`).join(', ')
      console.log(
        `[correct] ${fixed.ms}ms, learned ${learned.length}` +
          (learned.length ? ': ' + show(learned) : '') +
          (skipped.length ? ` | not learned (no glossary anchor): ${show(skipped)}` : '')
      )
      res.raw = res.text
      res.text = fixed.text
    } else if (!fixed.error) {
      console.log(`[correct] ${fixed.ms}ms, no change`)
    }

    // Archive last, and never let it affect the result the user is waiting on.
    if (config.data.corpus.enabled) {
      corpus.add({
        bytes,
        raw: res.raw ?? res.text,
        text: res.text,
        durationMs: payload.durationMs,
        model: config.data.stt.model || null,
        source: 'dictate',
        known: fixed.known,
        correctionUsage: fixed.usage,
      })
    }
    return res
  } catch (err) {
    // A throw here would reject the renderer's invoke() and strand the pill in
    // `working` forever. Always answer with a result object.
    console.error('[stt] threw:', err && err.message)
    return { ok: false, error: err && err.message ? err.message : 'transcription crashed' }
  }
})

/**
 * File a memo. RECORD ONLY: no network, no transcription, no AI.
 *
 * Transcription is deferred to "Transcribe memos" in the tray. A thought captured at
 * 3am and never revisited then never leaves the machine, and pressing the key returns
 * instantly instead of waiting on an upload.
 */
ipcMain.handle('pill:memo', async (_e, payload) => {
  const bytes = payload && payload.bytes
  if (!bytes || !bytes.length) return { ok: false, error: 'no audio' }
  try {
    const filed = memos.save({ bytes, durationMs: payload.durationMs })
    if (!filed.ok) {
      console.error('[memo] save failed:', filed.error)
      return { ok: false, error: filed.error }
    }
    console.log(
      `[memo] recorded ${filed.name} (${(filed.bytes / 1024 / 1024).toFixed(1)}MB, ` +
        `${Math.round(payload.durationMs / 1000)}s), not transcribed`
    )
    refreshTrayMenu()
    return { ok: true, name: filed.name, durationMs: payload.durationMs }
  } catch (err) {
    console.error('[memo] threw:', err && err.message)
    return { ok: false, error: (err && err.message) || 'memo failed' }
  }
})

/**
 * Transcribe every memo that has no transcript yet.
 *
 * This is the only point at which memo audio leaves the machine, and it only ever
 * runs because someone asked. A failure on one memo leaves its audio untouched and
 * moves on.
 */
async function transcribeMemos() {
  const waiting = memos.pending()
  if (!waiting.length) {
    console.log('[memo] nothing to transcribe')
    return { ok: true, done: 0, failed: 0 }
  }

  const m = config.data.memo
  console.log(`[memo] transcribing ${waiting.length} memo(s) with ${m.model}`)
  let done = 0
  let failed = 0

  for (const memo of waiting) {
    try {
      const bytes = fs.readFileSync(memos.audioPath(memo.name))
      const mb = bytes.length / (1024 * 1024)
      if (m.maxUploadMB && mb > m.maxUploadMB) {
        console.error(`[memo] ${memo.name}: ${mb.toFixed(1)}MB exceeds ${m.maxUploadMB}MB, skipped`)
        failed++
        continue
      }

      const res = await transcriber.transcribe(bytes, { model: m.model, timeoutMs: m.timeoutMs })
      if (!res || !res.ok) {
        console.error(`[memo] ${memo.name}:`, (res && res.error) || 'transcription failed')
        failed++
        continue
      }

      const raw = res.text || ''
      let text = raw
      const fixed = await corrector.fix(raw)
      if (fixed.error) console.error('[memo][correct]', fixed.error)
      if (fixed.changed) {
        const { learned, skipped } = lexicon.learnFromDiff(fixed.learnFrom ?? raw, fixed.learnTo ?? fixed.text, {
          anchors: config.data.correction.glossary,
        })
        console.log(`[memo][correct] ${memo.name}: learned ${learned.length}, skipped ${skipped.length}`)
        text = fixed.text
      }

      const att = memos.attach(memo.name, { text, raw })
      if (!att.ok) {
        console.error(`[memo] ${memo.name}: ${att.error}`)
        failed++
        continue
      }
      console.log(`[memo] ${memo.name} transcribed (${text.trim().split(/\s+/).filter(Boolean).length} words)`)
      done++
    } catch (err) {
      console.error(`[memo] ${memo.name} threw:`, err && err.message)
      failed++
    }
  }

  refreshTrayMenu()
  return { ok: true, done, failed }
}

ipcMain.handle('pill:insert', async (_e, text) => {
  try {
    const res = await insertText(text, {
      target: captureTarget,
      collapseNewlines: config.data.pill.collapseNewlines ?? undefined,
    })
    captureTarget = null
    if (!res.ok) console.error('[insert]', res.error)
    else console.log(`[insert] ${res.chars} chars via ${res.chord}${res.terminal ? ' (terminal)' : ''}`)
    return res
  } catch (err) {
    captureTarget = null
    console.error('[insert] threw:', err && err.message)
    return { ok: false, error: (err && err.message) || 'insert failed' }
  }
})

app.on('second-instance', () => {
  if (pillWin) pillWin.showInactive()
})

app.on('window-all-closed', () => {
  // Tray app: closing the pill is not quitting.
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
