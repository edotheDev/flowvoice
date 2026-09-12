'use strict'
/**
 * The memo store.
 *
 * Dictation is throwaway: the text lands in your caret and the audio is discarded.
 * A memo is the opposite, captured to be come back to, possibly months later and
 * possibly by something other than the app that recorded it. So this writes to a
 * plain, boring, greppable folder rather than anything clever:
 *
 *   %APPDATA%/flowvoice/memos/    (or memo.dir)
 *     INDEX.md                  one line per memo, newest last, rebuilt on change
 *     2026-08-17-1432.md        frontmatter always; transcript once there is one
 *     2026-08-17-1432.webm      the actual audio
 *     done/                     processed memos get moved here, .md + .webm together
 *
 * RECORDING DOES NOT TRANSCRIBE. A memo is filed as audio plus a stub, and the
 * transcript is attached later, on demand. That means a thought you capture at 3am
 * and never revisit never leaves the machine at all, and it makes recording instant
 * because nothing waits on a network round trip. Nothing is lost by waiting: the
 * audio is the source of truth, so the transcript (and everything the correction
 * pass learns from it) can be produced whenever.
 *
 * THE AUDIO IS KEPT ON PURPOSE. A transcript is a lossy read made by whichever model
 * happened to be current that day; keeping the source means a memo can be re-read
 * later by a better one, and means the (audio, corrected text) pairs needed for a
 * real voice fine-tune accumulate as a side effect of normal use. Opus at 32kbps is
 * ~14 MB/hour, so this costs approximately nothing to keep.
 */

const fs = require('fs')
const path = require('path')

/** Local time, not UTC: these are named for when he recorded them. */
function stamp(d) {
  const p = n => String(n).padStart(2, '0')
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes())
  )
}

function human(ms) {
  const s = Math.round(ms / 1000)
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/** First line of real content, for the index. */
function gist(text, max = 90) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  if (t.length <= max) return t
  return t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…'
}

/** Minimal frontmatter reader. Only the keys this file writes. */
function readFront(body) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(body)
  if (!m) return {}
  const out = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

class MemoStore {
  constructor(dir) {
    this.dir = dir
    this.doneDir = path.join(dir, 'done')
  }

  get indexFile() {
    return path.join(this.dir, 'INDEX.md')
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.doneDir, { recursive: true })
  }

  /** Build the page body from whatever we currently know about a memo. */
  page({ at, durationMs, name, text, raw }) {
    const has = !!String(text || '').trim()
    const lines = [
      '---',
      `recorded: ${at.toISOString()}`,
      `duration: ${human(durationMs)}`,
      `audio: ${name}.webm`,
      `status: ${has ? 'transcribed' : 'recorded'}`,
      '---',
      '',
    ]
    if (has) {
      lines.push(String(text).trim(), '')
      // Only worth keeping when correction actually changed something, otherwise it
      // is the same paragraph printed twice.
      const r = String(raw || '').trim()
      if (r && r !== String(text).trim()) {
        lines.push('', '---', '', '<!-- raw transcript, before correction -->', '', r, '')
      }
    } else {
      lines.push('_Not transcribed yet. The audio is saved._', '')
    }
    return lines.join('\n')
  }

  /**
   * File a recording. No network, no transcription, this is the whole of what
   * pressing the memo key does.
   *
   * @param {{bytes: Uint8Array, durationMs: number, at?: Date}} memo
   */
  save(memo) {
    try {
      this.ensure()

      // Same minute twice is rare but not impossible; never clobber a memo.
      const at = memo.at || new Date()
      const base = stamp(at)
      let name = base
      let n = 2
      while (fs.existsSync(path.join(this.dir, name + '.md'))) name = `${base}-${n++}`

      fs.writeFileSync(path.join(this.dir, name + '.webm'), Buffer.from(memo.bytes))
      fs.writeFileSync(
        path.join(this.dir, name + '.md'),
        this.page({ at, durationMs: memo.durationMs, name, text: '', raw: '' }),
        'utf8'
      )
      this.rebuildIndex()
      return { ok: true, name, bytes: memo.bytes.length }
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'could not save memo' }
    }
  }

  /** Memos that still have no transcript, oldest first. */
  pending() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .sort()
        .map(f => {
          const front = readFront(fs.readFileSync(path.join(this.dir, f), 'utf8'))
          return { name: f.replace(/\.md$/, ''), ...front }
        })
        .filter(m => m.status !== 'transcribed')
    } catch {
      return []
    }
  }

  /** Every memo awaiting processing, transcribed or not. */
  all() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .sort()
    } catch {
      return []
    }
  }

  audioPath(name) {
    return path.join(this.dir, name + '.webm')
  }

  /** Fill in a transcript produced later. */
  attach(name, { text, raw }) {
    try {
      const mdPath = path.join(this.dir, name + '.md')
      const front = readFront(fs.readFileSync(mdPath, 'utf8'))
      const at = new Date(front.recorded || Date.now())
      // Duration is stored as m:ss; recover ms so the page keeps rendering it.
      const [mm, ss] = String(front.duration || '0:00').split(':').map(Number)
      const durationMs = ((mm || 0) * 60 + (ss || 0)) * 1000
      fs.writeFileSync(mdPath, this.page({ at, durationMs, name, text, raw }), 'utf8')
      this.rebuildIndex()
      return { ok: true, name }
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'could not attach transcript' }
    }
  }

  /**
   * Rewrite INDEX.md from the files on disk.
   *
   * Regenerated rather than appended so it can never drift out of step with the
   * folder, a memo transcribed later, renamed, or deleted by hand is reflected on
   * the next write with no repair step.
   */
  rebuildIndex() {
    try {
      const rows = this.all().map(f => {
        const name = f.replace(/\.md$/, '')
        const body = fs.readFileSync(path.join(this.dir, f), 'utf8')
        const front = readFront(body)
        const text = body.replace(/^---\n[\s\S]*?\n---\n?/, '').split('\n---\n')[0]
        const done = front.status === 'transcribed'
        return `- [${name}](${name}.md) · ${front.duration || '?'} · ${
          done ? gist(text) || '(empty)' : 'not transcribed yet'
        }`
      })

      fs.writeFileSync(
        this.indexFile,
        [
          '# Voice memos',
          '',
          'Captured by FlowVoice. Recording does NOT transcribe: each memo is audio',
          'plus a stub until you ask for it to be read. Nothing here has been turned',
          'into content unless it sits in `done/`.',
          '',
          'Each memo is a `.md` page plus the `.webm` audio it came from.',
          'One line per memo, newest last.',
          '',
          ...rows,
          '',
        ].join('\n'),
        'utf8'
      )
    } catch {
      /* the index is a convenience; never let it break a save */
    }
  }
}

module.exports = { MemoStore }
