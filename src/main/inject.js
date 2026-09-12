'use strict'
/**
 * Putting text into whatever the user is actually typing in.
 *
 * Clipboard + synthesized Ctrl+V, because it is the only method that works the same
 * in Windows Terminal, VS Code, Chrome and native inputs. Per-character SendInput
 * with KEYEVENTF_UNICODE is the fallback for the rare app that ignores paste.
 *
 * The clipboard is restored afterwards, a dictation tool that silently eats what
 * you had copied is worse than one that does nothing.
 */

const { clipboard } = require('electron')
const win32 = require('./win32')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * Terminals running a TUI treat a newline in pasted text as "submit". Claude Code,
 * a shell prompt and a REPL will all fire on the first line and drop the rest, so
 * multi-line transcripts collapse to a single line before they go anywhere near one.
 */
function normalize(text, { collapseNewlines }) {
  let t = String(text).replace(/\r\n/g, '\n').trim()
  if (collapseNewlines) t = t.replace(/\s*\n+\s*/g, ' ')
  return t.replace(/[ \t]{2,}/g, ' ')
}

/**
 * Which paste chord the target actually honours.
 *
 * Ctrl+V is NOT universal: mintty (Git Bash) doesn't bind it at all unless
 * CtrlShiftShortcuts is enabled, and classic conhost (cmd / PowerShell console)
 * wants Shift+Insert. Sending Ctrl+V to either does nothing at all, silently.
 * Windows Terminal is the opposite case again (Ctrl+Shift+V), kept here for when
 * it's installed even though it isn't on this machine.
 */
function pasteChordFor(info) {
  const cls = (info && info.className ? info.className : '').toLowerCase()
  const title = (info && info.title ? info.title : '').toLowerCase()

  if (cls.includes('mintty')) return { shiftInsert: true, why: 'mintty' }
  if (cls.includes('consolewindowclass')) return { shiftInsert: true, why: 'conhost' }
  if (cls.includes('cascadia') || cls.includes('pseudoconsolewindow')) {
    return { shift: true, why: 'windows-terminal' }
  }
  if (title.includes('windows powershell') || title.includes('command prompt')) {
    return { shiftInsert: true, why: 'conhost-title' }
  }
  // Everything else, Chromium, Electron, Cursor's integrated terminal, native
  // inputs, takes plain Ctrl+V.
  return { why: 'ctrl-v' }
}

/** Rough heuristic for "is the thing I'm pasting into a terminal". */
function looksLikeTerminal(info) {
  if (!info) return false
  const cls = (info.className || '').toLowerCase()
  const title = (info.title || '').toLowerCase()
  return (
    cls.includes('consolewindowclass') ||
    cls.includes('pseudoconsolewindow') ||
    cls.includes('cascadia') ||
    cls.includes('mintty') ||
    title.includes('windows powershell') ||
    title.includes('command prompt') ||
    /(^|[\s\-—|])(cmd|powershell|pwsh|bash|wsl|terminal)([\s\-—|]|$)/.test(title)
  )
}

async function insertText(text, opts = {}) {
  const target = opts.target || win32.getForegroundInfo()
  const terminal = looksLikeTerminal(target)
  const payload = normalize(text, { collapseNewlines: opts.collapseNewlines ?? terminal })

  if (!payload) return { ok: false, error: 'nothing to insert' }
  if (!win32.init()) return { ok: false, error: 'native layer unavailable' }

  // If focus did drift (elevated app, stray click), put it back before typing.
  const current = win32.getForegroundInfo()
  if (target && current && current.hwnd !== target.hwnd) {
    win32.focusWindow(target.hwnd)
    await sleep(60)
  }

  // The hotkey's own modifiers may still be physically held; releasing them stops
  // Ctrl+V turning into Ctrl+Shift+V (which pastes differently, or not at all).
  win32.releaseModifiers()
  await sleep(20)

  const saved = readClipboard()

  try {
    clipboard.writeText(payload)
    // Windows needs a beat to publish the new clipboard contents before a paste
    // will pick them up; without this the target sometimes pastes the old value.
    await sleep(70)

    const chord = pasteChordFor(target)
    const pasted = chord.shiftInsert ? win32.sendShiftInsert() : win32.sendPaste({ shift: chord.shift })
    if (!pasted) throw new Error('SendInput refused')

    await sleep(140)
    return { ok: true, chars: payload.length, viaClipboard: true, terminal, chord: chord.why }
  } catch (err) {
    // Clipboard route failed, type it instead. Slower, but leaves no residue.
    const typed = win32.sendUnicodeText(payload)
    return typed
      ? { ok: true, chars: payload.length, viaClipboard: false, terminal }
      : { ok: false, error: err.message || 'injection failed' }
  } finally {
    restoreClipboard(saved)
  }
}

function readClipboard() {
  try {
    return { text: clipboard.readText(), html: clipboard.readHTML() }
  } catch {
    return null
  }
}

function restoreClipboard(saved) {
  if (!saved) return
  // Delay past the paste so we don't swap the contents out from under the target.
  setTimeout(() => {
    try {
      if (saved.html) clipboard.write({ text: saved.text, html: saved.html })
      else if (saved.text) clipboard.writeText(saved.text)
      else clipboard.clear()
    } catch {
      /* leaving our text on the clipboard is a survivable outcome */
    }
  }, 400)
}

module.exports = { insertText, normalize, looksLikeTerminal }
