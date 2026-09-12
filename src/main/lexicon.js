'use strict'
/**
 * Correction memory.
 *
 * Whisper mishears the same handful of words over and over for any given speaker:
 * always the same names, the same accent-specific vowels. Rather than pay an LLM to
 * rediscover that every time, we watch what the correction pass actually changes and
 * remember it. A pair seen often enough is promoted into the prompt as a known habit,
 * which makes the correction both faster to agree with and far more stable.
 *
 * The other reason this file exists: these pairs ARE labeled training data. Every
 * confirmed (misheard -> correct) pair is one example of how this speaker's voice
 * differs from the model's expectation. A real fine-tune later needs exactly this,
 * and it can only be collected by starting now.
 */

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

/** Beyond this the prompt would bloat and the oldest habits stop mattering. */
const MAX_PAIRS = 400

/** A substitution longer than this is a rewrite, not a mishearing. */
const MAX_RUN_WORDS = 3

/**
 * Key separator. NUL because it cannot occur in a transcript, so "a b"->"c" and
 * "a"->"b c" can never collide, a plain space would conflate those two.
 * Built with fromCharCode rather than typed literally: an earlier version embedded
 * the raw byte in the source, where it was invisible in every editor and made the
 * whole file read as binary to grep.
 */
const SEP = String.fromCharCode(0)

/**
 * How alike two strings are, 0..1, ignoring case and spacing.
 *
 * A mishearing sounds like what was said. "Claw"/"Claude" and "higs field"/
 * "Higgsfield" are near-identical; "Spice Nemo"/"ElevenLabs" is not remotely close:
 * that is the corrector inventing, not correcting.
 */
function similarity(a, b) {
  const s = String(a).toLowerCase().replace(/\s+/g, '')
  const t = String(b).toLowerCase().replace(/\s+/g, '')
  if (!s || !t) return 0
  if (s === t) return 1
  // Levenshtein, one row at a time.
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i)
  for (let i = 1; i <= s.length; i++) {
    const row = [i]
    for (let j = 1; j <= t.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      )
    }
    prev = row
  }
  return 1 - prev[t.length] / Math.max(s.length, t.length)
}

/**
 * Below this, the "correction" shares too little with what was said to be one.
 *
 * Tuned against real pairs rather than picked: "Claw"/"Claude" and "noshun"/"Notion"
 * both sit at 0.50 and are genuine, while "Spice Nemo"/"ElevenLabs" is 0.20. 0.55
 * rejected the first two; 0.45 keeps them and still leaves a wide margin over the
 * inventions.
 */
const MIN_SIMILARITY = 0.45

/** Strip surrounding punctuation so "Claude." and "Claude" are the same word. */
function norm(w) {
  return w
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
}

function tokenize(s) {
  return String(s).trim().split(/\s+/).filter(Boolean)
}

/**
 * Word-level substitutions between two versions of the same utterance.
 *
 * Standard LCS alignment, then every maximal run that exists in both sides but
 * differs is one substitution. Runs that are pure insertions or deletions are
 * ignored: those are the model adding or dropping filler, which is not a
 * mishearing and must never be learned as one.
 */
function diffPairs(before, after) {
  const a = tokenize(before)
  const b = tokenize(after)
  if (!a.length || !b.length) return []

  const na = a.map(norm)
  const nb = b.map(norm)

  // LCS length table. Utterances are short (dictation, not documents), so the
  // O(n*m) table is cheaper than being clever.
  const L = Array.from({ length: na.length + 1 }, () => new Uint16Array(nb.length + 1))
  for (let i = na.length - 1; i >= 0; i--) {
    for (let j = nb.length - 1; j >= 0; j--) {
      L[i][j] = na[i] === nb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    }
  }

  const pairs = []
  let i = 0
  let j = 0
  while (i < na.length && j < nb.length) {
    if (na[i] === nb[j]) {
      i++
      j++
      continue
    }
    // Walk both sides forward to the next point where they agree again.
    const si = i
    const sj = j
    while (i < na.length && j < nb.length && na[i] !== nb[j]) {
      if (L[i + 1][j] >= L[i][j + 1]) i++
      else j++
    }
    // If the walk ran off the end of one side, the whole remaining tail of the other
    // side is the replacement. Without this, a substitution at the very end of an
    // utterance produced an empty `to` and was discarded as an insertion, losing
    // exactly the cases that matter most, since a sentence tends to end on the name
    // it was about ("...ask Claude", "...open Notion").
    const iEnd = j >= nb.length ? na.length : i
    const jEnd = i >= na.length ? nb.length : j
    const from = a.slice(si, iEnd)
    const to = b.slice(sj, jEnd)
    // Both sides non-empty means a real replacement, not an insert or a delete.
    if (from.length && to.length && from.length <= MAX_RUN_WORDS && to.length <= MAX_RUN_WORDS) {
      pairs.push({ from: from.join(' '), to: to.join(' ') })
    }
  }
  return pairs
}

class Lexicon {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'lexicon.json')
    /** key -> { from, to, n } */
    this.pairs = {}
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.pairs = raw && typeof raw.pairs === 'object' && raw.pairs ? raw.pairs : {}
    } catch {
      this.pairs = {}
      this.save()
    }
    return this
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      // Sorted by frequency so opening the file by hand is actually informative:
      // the top of the list is what this voice gets wrong most.
      const sorted = Object.entries(this.pairs).sort((x, y) => y[1].n - x[1].n)
      const trimmed = Object.fromEntries(sorted.slice(0, MAX_PAIRS))
      this.pairs = trimmed
      fs.writeFileSync(this.file, JSON.stringify({ pairs: trimmed }, null, 2), 'utf8')
    } catch {
      /* a read-only profile shouldn't take the app down */
    }
  }

  /**
   * Learn substitutions the correction pass made, but only the ones we trust.
   *
   * `opts.anchors` is the glossary. A pair is learned only when the CORRECTED side
   * contains a glossary term, because that is the one class of correction the
   * corrector is reliably right about: it was handed those names and told to watch
   * for them.
   *
   * Everything else is the corrector guessing between two ordinary English words,
   * and it does guess wrong. Observed on the first real run: "voice flow" was
   * transcribed as "price flow", and the corrector "fixed" flow -> view. Learned
   * unfiltered, that pair reaches the promotion threshold on its second sighting and
   * is then asserted as fact in every later prompt, a wrong correction that
   * entrenches itself and corrupts transcripts that would otherwise have been fine.
   *
   * Precision over recall is the right trade: a pair we decline to learn costs only a
   * missed improvement, while a wrong pair actively damages good output.
   *
   * @returns {{learned: Array<{from: string, to: string}>, skipped: Array<{from: string, to: string}>}}
   */
  learnFromDiff(before, after, opts = {}) {
    const found = diffPairs(before, after)
    if (!found.length) return { learned: [], skipped: [] }

    // Split multi-word glossary entries so "Claude Code" anchors on either half.
    const anchors = new Set()
    for (const a of opts.anchors || []) {
      for (const part of tokenize(a)) {
        const w = norm(part)
        if (w) anchors.add(w)
      }
    }
    const anchored = to =>
      anchors.size > 0 && tokenize(to).map(norm).some(w => w && anchors.has(w))

    const learned = []
    const skipped = []
    for (const p of found) {
      const key = norm(p.from) + SEP + norm(p.to)
      if (key === SEP) continue
      // Two independent gates. Anchoring alone is not enough: when the transcript is
      // garbage the corrector guesses toward the glossary precisely because that is
      // the vocabulary it was handed, so "Spice Nemo" -> "ElevenLabs" passes the
      // anchor test while being pure invention. Requiring the pair to actually sound
      // alike is what separates a correction from a guess.
      if (!anchored(p.to) || similarity(p.from, p.to) < MIN_SIMILARITY) {
        skipped.push(p)
        continue
      }
      if (this.pairs[key]) this.pairs[key].n++
      else this.pairs[key] = { from: p.from, to: p.to, n: 1 }
      learned.push(p)
    }
    if (learned.length) this.save()
    return { learned, skipped }
  }

  /**
   * Pairs safe to apply deterministically, longest first.
   *
   * A multi-word phrase carries its own context and is safe to swap on sight. A bare
   * word is not: it fires everywhere the word appears, including the sentences where
   * the speaker meant it.
   *
   * This started as a stoplist of words never to substitute alone, and that failed
   * the moment a word I had not thought of came up, the corrector learned
   * "remote" -> "memo" twice and promoted it, which would have turned "remote team"
   * into "memo team". Enumerating ordinary English by hand does not work.
   *
   * So single words are applied ONLY when explicitly seeded by a human. Auto-learned
   * single words are still recorded (they are useful as data, and as fine-tune
   * material) but are never applied on their own.
   */
  applicable() {
    return Object.values(this.pairs)
      .filter(p => tokenize(p.from).length > 1 || p.seeded === true)
      .sort((a, b) => b.from.length - a.from.length)
  }

  /** Drop learned pairs by their misheard side. For pruning a bad rule by hand. */
  forget(from) {
    const f = norm(from)
    let n = 0
    for (const key of Object.keys(this.pairs)) {
      if (norm(this.pairs[key].from) === f) {
        delete this.pairs[key]
        n++
      }
    }
    if (n) this.save()
    return n
  }

  /**
   * The pairs confident enough to state as fact in the prompt.
   *
   * A single sighting is a guess: the LLM may simply have been wrong. Repeats are
   * what turn a guess into this speaker's actual habit.
   */
  confirmed(minCount = 2, limit = 40) {
    return Object.values(this.pairs)
      .filter(p => p.n >= minCount)
      .sort((a, b) => b.n - a.n)
      .slice(0, limit)
  }

  get size() {
    return Object.keys(this.pairs).length
  }
}

/** Escape a phrase for use inside a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Apply known mishearings deterministically.
 *
 * This exists because injecting the pair list into the correction prompt does not
 * work. Measured: given "price memo" -> "voice memo" as a stated rule, the model
 * also rewrote "the price of Deepgram" to "the voice of Deepgram" and "demo video"
 * to "voice memo", it generalises from the list no matter how the caveat is worded.
 * An exact, case-preserving, word-boundary replacement cannot do that: a phrase
 * either appears or it does not.
 *
 * The LLM pass still runs afterwards, for the open-ended corrections that genuinely
 * need judgement. This just takes the known answers off its plate.
 */
function applyKnownFixes(text, pairs) {
  let out = String(text || '')
  const hits = []
  for (const p of pairs) {
    const re = new RegExp(`\\b${escapeRe(p.from)}\\b`, 'gi')
    if (!re.test(out)) continue
    re.lastIndex = 0
    out = out.replace(re, m => {
      hits.push({ from: m, to: p.to })
      // Mirror the casing that was actually transcribed, so a sentence-initial
      // "Price memo" becomes "Voice memo" rather than "voice memo".
      return /^[A-Z]/.test(m) ? p.to.charAt(0).toUpperCase() + p.to.slice(1) : p.to
    })
  }
  return { text: out, hits }
}

module.exports = { Lexicon, diffPairs, applyKnownFixes, similarity }
