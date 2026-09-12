'use strict'
/**
 * Voice pill behaviour.
 *
 * The window is a fixed 560x132 rectangle but the pill inside it is a 52x4 sliver at
 * rest, so the window is click-through by default and only becomes interactive while
 * the pointer is genuinely over the pill. That handoff is this file's main job,
 * alongside audio capture and the state machine.
 *
 * States: idle -> recording -> working -> review -> (insert | discard) -> idle
 *
 * Two modes share that machine. `dictate` is the primary one and ends at the caret.
 * `memo` is secondary, on its own hotkey: it records long-form, skips the review step
 * entirely, and is filed to disk instead of inserted. Capture only, a memo is never
 * acted on here, only stored for later.
 */

const $ = id => document.getElementById(id)
const el = {
  stage: $('stage'),
  pill: $('pill'),
  ctrl: $('ctrl'),
  hint: $('hint'),
  keyhint: $('keyhint'),
  wave: $('wave'),
  timer: $('timer'),
  text: $('text'),
  kill: $('kill'),
  mode: $('mode'),
}

const ctx2d = el.wave.getContext('2d')

let state = 'idle'
let media = null
let recorder = null
let sessionSeq = 0
// startRecording awaits getUserMedia, during which `state` is still 'idle', so two
// toggles in quick succession both got past the state guard and both built a
// recorder. This closes that window.
let starting = false
let audioCtx = null
let analyser = null
let rafId = null
let startedAt = 0
let timerId = null
let transcript = ''
let levels = new Array(72).fill(0)
let stallId = null
/** When the last audio chunk arrived, so a dead microphone can be spotted. */
let lastChunkAt = 0
let silenceId = null
/** Chunks arrive every 250ms; this much silence means the input is gone. */
const DEAD_MIC_MS = 4000
/** 'dictate' (primary, ends at the caret) | 'memo' (secondary, ends on disk). */
let mode = 'dictate'
/** Paste the moment the text is ready, rather than waiting for a confirm keypress. */
let autoInsert = true

// Nothing downstream of `working` is guaranteed to answer. The provider call has its
// own 30s abort, but a rejected IPC, a renderer hiccup or a hung fetch used to leave
// the pill spinning with no way back: the hotkey ignores `working`, Esc wasn't bound
// there, and only quitting the app cleared it. This is the backstop.
const STALL_MS = 40000
// A memo is a bigger upload through a slower model, and main allows it minutes. The
// watchdog has to outlast that or it would kill healthy long transcriptions.
const MEMO_STALL_MS = 330000

function setState(next) {
  state = next
  el.stage.dataset.state = next
  window.voice.pillState(next)

  if (stallId) {
    clearTimeout(stallId)
    stallId = null
  }
  if (next === 'working') {
    stallId = setTimeout(
      () => {
        if (state === 'working') showError('transcription stalled')
      },
      mode === 'memo' ? MEMO_STALL_MS : STALL_MS
    )
  }
}

function setMode(next) {
  mode = next
  el.stage.dataset.mode = next
  el.mode.textContent = next === 'memo' ? 'MEMO' : ''
}

/* ---------- click-through handoff ---------- */

// The pointer is "on the pill" only when it is inside the pill's own painted box,
// not merely inside the window. Main flips setIgnoreMouseEvents from this.
let interactive = false
function updateInteractive(x, y) {
  const r = el.pill.getBoundingClientRect()
  // Generous vertical slack while collapsed: the sliver is 4px tall and nobody
  // should have to pixel-hunt for it. Once expanded the real bounds are enough.
  // Hysteresis: the hit area is larger once engaged. Without it the pill sits on its
  // own boundary, expanding grows the rect, which changes the answer, which
  // collapses it again, and flickers between sliver and island.
  const grip = interactive ? 18 : 0
  const padX = (state === 'idle' ? 24 : 0) + grip
  const padY = (state === 'idle' ? 14 : 0) + grip
  const over =
    x >= r.left - padX && x <= r.right + padX && y >= r.top - padY && y <= r.bottom + padY

  // CSS :hover never fires while the window ignores mouse events, so the hover
  // look has to be a class driven from these forwarded coordinates.
  el.stage.classList.toggle('hot', over)

  if (over === interactive) return
  interactive = over
  window.voice.setInteractive(over)
}

// While the window is click-through, Electron forwards mousemove but never
// mouseleave, so hover has to be derived from coordinates on every move.
// Real DOM events only arrive once the window has been made interactive; the polled
// feed below is what covers the click-through case.
window.addEventListener('mousemove', e => updateInteractive(e.clientX, e.clientY))
window.voice.onPointer(pt => {
  if (pt) updateInteractive(pt.x, pt.y)
  else {
    el.stage.classList.remove('hot')
    if (interactive) { interactive = false; window.voice.setInteractive(false) }
  }
})

window.addEventListener('mouseleave', () => {
  el.stage.classList.remove('hot')
  if (!interactive) return
  interactive = false
  window.voice.setInteractive(false)
})

/* ---------- recording ---------- */

/**
 * Stop a recorder and make sure it can never speak again.
 *
 * Detaching the handlers matters as much as stopping: a recorder that outlives its
 * session keeps firing `dataavailable` every timeslice, and its handler is what
 * poisons later recordings.
 */
function hardStopRecorder() {
  if (silenceId) {
    clearInterval(silenceId)
    silenceId = null
  }
  if (!recorder) return
  const r = recorder
  recorder = null
  r.ondataavailable = null
  r.onstop = null
  r.onerror = null
  try {
    if (r.state !== 'inactive') r.stop()
  } catch {
    /* already gone */
  }
}

async function startRecording(nextMode = 'dictate') {
  if (starting || state === 'recording' || state === 'working') return
  starting = true
  try {
    setMode(nextMode)
    // Anything left from a previous attempt dies before a new recorder exists.
    hardStopRecorder()

    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch {
      return showError('no microphone access')
    }

    // Each session gets its OWN buffer, captured by this closure.
    //
    // This used to be one module-scope array, and the handler read it by name at
    // call time, so `chunks = []` at the top of a new session didn't detach an old
    // recorder from it, it just redirected the old recorder into the NEW array. One
    // orphaned recorder therefore spliced its stream into every later recording, and
    // the upload became several complete webm files glued end to end. Groq answered
    // exactly what that is: 400 "could not process file - is it a valid media file?".
    // Per-session buffers make that impossible regardless of what leaks.
    const myChunks = []
    const id = ++sessionSeq

    // A device that disappears between getUserMedia and here, or an audio stack that
    // refuses a new context, throws synchronously. Uncaught it would leave a live mic
    // track open with no recorder attached to it.
    try {
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      recorder = new MediaRecorder(media, { mimeType: mime, audioBitsPerSecond: 32000 })
      recorder.ondataavailable = e => {
        if (e.data && e.data.size) {
          myChunks.push(e.data)
          lastChunkAt = Date.now()
        }
      }

      // A microphone can be taken away mid recording: Windows switches the default
      // device, or another app claims it. The track ends, MediaRecorder goes quiet,
      // and nothing else notices, the timer keeps counting and you believe you are
      // still recording. Measured on a real memo: 159 seconds on the clock, 52
      // seconds of audio. Both guards below exist to make that impossible to miss.
      for (const track of media.getTracks()) {
        track.addEventListener('ended', () => {
          if (state !== 'recording') return
          console.error('[pill] microphone stopped mid recording')
          stopRecording()
        })
      }

      // Belt and braces: a stalled recorder may never fire `ended` at all, so also
      // watch for the chunks simply drying up.
      lastChunkAt = Date.now()
      silenceId = setInterval(() => {
        if (state !== 'recording') return
        if (Date.now() - lastChunkAt < DEAD_MIC_MS) return
        console.error('[pill] no audio for ' + Math.round((Date.now() - lastChunkAt) / 1000) + 's, stopping')
        stopRecording()
      }, 1000)
      recorder.onstop = () => handleStop(myChunks, id)
      recorder.onerror = e => {
        teardownAudio()
        showError((e && e.error && e.error.message) || 'recorder error')
      }
      recorder.start(250)

      audioCtx = new AudioContext()
      const src = audioCtx.createMediaStreamSource(media)
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.7
      src.connect(analyser)
    } catch (err) {
      teardownAudio()
      return showError((err && err.message) || 'could not start recording')
    }

    levels = new Array(72).fill(0)
    startedAt = Date.now()
    setState('recording')
    drawWave()
    tickTimer()
    timerId = setInterval(tickTimer, 500)
  } finally {
    starting = false
  }
}

function tickTimer() {
  const s = Math.floor((Date.now() - startedAt) / 1000)
  el.timer.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

function drawWave() {
  if (state !== 'recording' || !analyser) return
  const buf = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteTimeDomainData(buf)

  let peak = 0
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i] - 128) / 128
    if (v > peak) peak = v
  }
  // Speech rarely approaches full scale, so normal talking should use most of the
  // available height rather than a timid flicker at the baseline.
  const level = Math.min(1, peak * 2.6)
  levels.push(level)
  levels.shift()
  el.pill.style.setProperty('--lvl', level.toFixed(3))

  const dpr = window.devicePixelRatio || 1
  const w = el.wave.clientWidth
  const h = el.wave.clientHeight
  if (!w || !h) return (rafId = requestAnimationFrame(drawWave))
  if (el.wave.width !== Math.round(w * dpr)) {
    el.wave.width = Math.round(w * dpr)
    el.wave.height = Math.round(h * dpr)
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx2d.clearRect(0, 0, w, h)

  const n = levels.length
  const gap = 2
  const barW = Math.max(1.5, w / n - gap)
  const mid = h / 2
  for (let i = 0; i < n; i++) {
    const bh = Math.max(1.5, levels[i] * (h - 4))
    const x = i * (barW + gap)
    // Dark ink on the light pill; older samples fade toward the left so the bar
    // reads as time passing.
    ctx2d.fillStyle = `rgba(18,19,22,${(0.16 + (i / n) * 0.62).toFixed(3)})`
    roundRect(x, mid - bh / 2, barW, bh, barW / 2)
    ctx2d.fill()
  }
  rafId = requestAnimationFrame(drawWave)
}

function roundRect(x, y, w, h, r) {
  ctx2d.beginPath()
  const rr = Math.min(r, w / 2, h / 2)
  ctx2d.moveTo(x + rr, y)
  ctx2d.arcTo(x + w, y, x + w, y + h, rr)
  ctx2d.arcTo(x + w, y + h, x, y + h, rr)
  ctx2d.arcTo(x, y + h, x, y, rr)
  ctx2d.arcTo(x, y, x + w, y, rr)
  ctx2d.closePath()
}

function stopRecording() {
  if (state !== 'recording' || !recorder) return
  if (timerId) clearInterval(timerId)
  if (rafId) cancelAnimationFrame(rafId)
  timerId = rafId = null
  setState('working')
  try {
    recorder.stop()
  } catch {
    teardownAudio()
    showError('recorder failed')
  }
}

/**
 * True length of the captured audio, by decoding it.
 *
 * Falls back to the wall clock if decoding fails, since a duration that is merely
 * approximate is far better than losing the recording over a measurement.
 */
async function audioDuration(arrayBuffer, fallbackMs) {
  let ctx = null
  try {
    ctx = new AudioContext()
    // decodeAudioData detaches the buffer it is given, so hand it a copy, the
    // original still has to be uploaded afterwards.
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
    return Math.round(decoded.duration * 1000)
  } catch {
    return fallbackMs
  } finally {
    if (ctx) ctx.close().catch(() => {})
  }
}

function teardownAudio() {
  // Stopping the tracks does not reliably end a MediaRecorder, so end it explicitly.
  hardStopRecorder()
  if (media) media.getTracks().forEach(t => t.stop())
  if (audioCtx) audioCtx.close().catch(() => {})
  media = audioCtx = analyser = null
}

async function handleStop(sessionChunks, id) {
  const wallMs = Date.now() - startedAt
  const blob = new Blob(sessionChunks, { type: 'audio/webm' })
  teardownAudio()

  // Shorter than a breath is a mis-press, not an utterance.
  if (wallMs < 400 || blob.size < 1200) return reset()

  // This runs as MediaRecorder's onstop handler, so nothing is awaiting it and a
  // throw would vanish into an unhandled rejection with the pill left in `working`.
  try {
    const buf = await blob.arrayBuffer()
    const bytes = new Uint8Array(buf)

    // Measure the audio we ACTUALLY captured rather than trusting the clock. If the
    // microphone died mid recording the timer kept counting, and storing wall time
    // would claim audio that does not exist, poisoning the memo page, the index,
    // the corpus and the cost figure all at once.
    const durationMs = await audioDuration(buf, wallMs)
    const lost = wallMs - durationMs
    console.log(
      `[pill] session ${id}: ${sessionChunks.length} chunks, ${blob.size}B, ` +
        `${durationMs}ms audio / ${wallMs}ms elapsed`
    )
    if (lost > Math.max(3000, wallMs * 0.1)) {
      console.error(
        `[pill] LOST ${Math.round(lost / 1000)}s of audio: the microphone stopped ` +
          `delivering partway through. Kept ${Math.round(durationMs / 1000)}s.`
      )
    }

    if (mode === 'memo') {
      // No review step. A memo is filed as-is; the point is to get the thought out
      // and keep moving, not to proofread it standing at your desk.
      const res = await window.voice.memo({ bytes, durationMs })
      if (!res || !res.ok) return showError((res && res.error) || 'memo failed')
      el.text.textContent = `memo saved · ${res.name}`
      setState('saved')
      return setTimeout(() => {
        if (state === 'saved') reset()
      }, 2200)
    }

    const res = await window.voice.transcribe({ bytes, durationMs })
    if (!res || !res.ok) return showError((res && res.error) || 'transcription failed')

    const t = (res.text || '').trim()
    if (!t) return showError('nothing heard')
    transcript = t
    el.text.textContent = t

    // Straight into whatever had focus, the terminal, the chat box, the editor.
    // Parking it here for a second keypress made every dictation two gestures.
    if (autoInsert) return deliver(t)
    setState('review')
  } catch (err) {
    showError((err && err.message) || 'transcription failed')
  }
}

/* ---------- review ---------- */

/**
 * Hand the text to the window that had focus when recording began.
 *
 * A failed paste has to be visible. The clipboard route can be refused outright by
 * some targets, and silently collapsing back to idle would look identical to a
 * successful dictation that went nowhere, so the pill holds the transcript and says
 * what happened instead.
 */
async function deliver(text) {
  const res = await window.voice.insert(text)
  if (!res || !res.ok) {
    el.text.textContent = text
    return showError((res && res.error) || 'could not insert')
  }
  reset()
}

function confirm() {
  if (state !== 'review' || !transcript) return
  deliver(transcript)
}

function discard() {
  if (state === 'idle') return
  reset()
}

function showError(msg) {
  transcript = ''
  el.text.textContent = msg
  // Main forwards renderer console messages into its own log, so this is what makes
  // a provider code readable after the pill has wiped it off screen.
  console.error('[pill] ' + msg)
  setState('error')
  setTimeout(() => {
    if (state === 'error') reset()
  }, 2600)
}

function reset() {
  transcript = ''
  el.text.textContent = ''
  el.timer.textContent = '0:00'
  el.pill.style.setProperty('--lvl', '0')
  ctx2d.clearRect(0, 0, el.wave.width, el.wave.height)
  // Always fall back to the primary mode. Memo is opt-in per recording and must
  // never become sticky, a mode you forgot you were in files what you meant to type.
  setMode('dictate')
  setState('idle')
  // Hand click-through back unless the pointer is still resting on the sliver.
  if (!interactive) window.voice.setInteractive(false)
}

/* ---------- input ---------- */

function toggle() {
  if (state === 'idle') startRecording('dictate')
  // Stops whatever is recording, memo included, a stop key that refuses to stop
  // because you're in the other mode is just a trap.
  else if (state === 'recording') stopRecording()
  else if (state === 'review') confirm()
  // `working` and `error` used to swallow the hotkey entirely, so a failed
  // transcription made the pill look permanently dead. The key now always does
  // something: it abandons the stuck attempt and hands back a usable pill.
  else reset()
}

function toggleMemo() {
  if (state === 'idle') startRecording('memo')
  else if (state === 'recording') stopRecording()
  else reset()
}

el.ctrl.addEventListener('click', e => {
  e.stopPropagation()
  toggle()
})
el.kill.addEventListener('click', e => {
  e.stopPropagation()
  discard()
})
// In review the whole pill confirms, so there is no button to aim at.
el.pill.addEventListener('click', () => {
  if (state === 'review') confirm()
  // Clicking the pill is the primary gesture, so it always means dictation.
  // Memos are deliberate enough to deserve their own key.
  else if (state === 'idle') startRecording('dictate')
})

window.voice.onCommand(cmd => {
  switch (cmd) {
    case 'toggle':
      toggle()
      break
    case 'memo':
      toggleMemo()
      break
    case 'start':
      if (state === 'idle') startRecording('dictate')
      break
    case 'stop':
      if (state === 'recording') stopRecording()
      break
    case 'cancel':
      if (state === 'recording') {
        if (timerId) clearInterval(timerId)
        if (rafId) cancelAnimationFrame(rafId)
        timerId = rafId = null
        // hardStopRecorder detaches onstop, so the abandoned audio is never
        // submitted, no need to blank a buffer to suppress it.
        teardownAudio()
        reset()
      } else discard()
      break
  }
})

window.voice.onConfig(cfg => {
  if (!cfg) return
  if (cfg.hotkey) el.keyhint.textContent = cfg.hotkey.replace(/Control/g, 'Ctrl')
  if (typeof cfg.autoInsert === 'boolean') autoInsert = cfg.autoInsert
})

reset()
