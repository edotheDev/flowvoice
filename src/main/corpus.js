'use strict'
/**
 * The training corpus.
 *
 * Accuracy cannot improve day by day without a record of what was actually said and
 * what it should have been. Dictation used to discard its audio the moment the text
 * came back, which meant every accuracy question had to be answered by hand-tuning
 * against whatever sentence happened to fail that day, overfitting to one example,
 * with no way to tell whether a change helped in general.
 *
 * So every dictation is kept: the audio, the raw transcript, and the final text.
 * Nothing here is read at runtime; it accrues quietly in the background and pays off
 * three ways:
 *
 *   1. Benchmarking. A/B a different model or provider on THIS speaker's voice
 *      instead of on published averages.
 *   2. Regression testing. A correction-rule change can be replayed over months of
 *      real transcripts rather than judged on one sentence.
 *   3. Fine-tuning. (audio, correct text) pairs are exactly the training data a
 *      voice-adapted model needs, and the only way to have 10+ hours a year from now
 *      is to start keeping them now.
 *
 * Layout:
 *   %APPDATA%/flowvoice/corpus/   (or corpus.dir)
 *     index.jsonl              one JSON object per utterance, append-only
 *     clips/<id>.webm          the audio for that utterance
 *
 * Bounded on purpose: Opus at 32kbps is ~14 MB/hour, so a heavy year is a couple of
 * GB. Past the cap the oldest clips are dropped, oldest first. The index lines stay:
 * they are tiny, and the text alone is still useful once the audio is gone.
 */

const fs = require('fs')
const path = require('path')

class Corpus {
  constructor(dir, opts = {}) {
    this.dir = dir
    this.clipDir = path.join(dir, 'clips')
    this.maxBytes = (opts.maxMB || 2048) * 1024 * 1024
  }

  get indexFile() {
    return path.join(this.dir, 'index.jsonl')
  }

  ensure() {
    fs.mkdirSync(this.clipDir, { recursive: true })
  }

  /**
   * Record one utterance. Never throws and never blocks the caller's result:
   * failing to archive a dictation must not cost the user the dictation.
   *
   * @param {{bytes: Uint8Array, raw: string, text: string, durationMs: number,
   *          model?: string, source?: string, known?: Array, at?: Date}} u
   */
  add(u) {
    try {
      this.ensure()
      const at = u.at || new Date()
      const id = String(at.getTime()) + '-' + Math.abs(hash(u.raw || '')).toString(36)
      const clip = path.join(this.clipDir, id + '.webm')
      fs.writeFileSync(clip, Buffer.from(u.bytes))

      const row = {
        id,
        at: at.toISOString(),
        source: u.source || 'dictate',
        model: u.model || null,
        durationMs: u.durationMs,
        bytes: u.bytes.length,
        clip: path.join('clips', id + '.webm').replace(/\\/g, '/'),
        raw: u.raw || '',
        text: u.text || '',
        // Whether the text differs from the raw transcript is the cheap label for
        // "was this one the transcriber got wrong", which is what a later pass wants.
        corrected: (u.text || '') !== (u.raw || ''),
        known: (u.known || []).map(h => [h.from, h.to]),
        // Token counts from the correction call, so spend is priced exactly.
        correctionUsage: u.correctionUsage || null,
      }
      fs.appendFileSync(this.indexFile, JSON.stringify(row) + '\n', 'utf8')
      this.prune()
      return { ok: true, id }
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'corpus write failed' }
    }
  }

  /** Drop oldest clips once the audio exceeds the cap. Index lines are kept. */
  prune() {
    try {
      const files = fs
        .readdirSync(this.clipDir)
        .filter(f => f.endsWith('.webm'))
        .map(f => {
          const p = path.join(this.clipDir, f)
          return { p, size: fs.statSync(p).size, name: f }
        })
      let total = files.reduce((n, f) => n + f.size, 0)
      if (total <= this.maxBytes) return 0

      // Names lead with the timestamp, so lexical order is chronological.
      files.sort((a, b) => (a.name < b.name ? -1 : 1))
      let dropped = 0
      for (const f of files) {
        if (total <= this.maxBytes) break
        fs.unlinkSync(f.p)
        total -= f.size
        dropped++
      }
      if (dropped) console.log(`[corpus] pruned ${dropped} old clip(s)`)
      return dropped
    } catch {
      return 0
    }
  }

  stats() {
    try {
      const clips = fs.readdirSync(this.clipDir).filter(f => f.endsWith('.webm'))
      const bytes = clips.reduce((n, f) => n + fs.statSync(path.join(this.clipDir, f)).size, 0)
      const lines = fs.existsSync(this.indexFile)
        ? fs.readFileSync(this.indexFile, 'utf8').split('\n').filter(Boolean).length
        : 0
      return { utterances: lines, clips: clips.length, mb: bytes / 1024 / 1024 }
    } catch {
      return { utterances: 0, clips: 0, mb: 0 }
    }
  }
}

/** Cheap non-crypto hash, only to keep ids unique within a millisecond. */
function hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

module.exports = { Corpus }
