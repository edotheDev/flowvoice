'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

/**
 * Every setting, with its default. On first launch this is written to
 * %APPDATA%\flowvoice\config.json, which is the file to edit (tray: Edit settings).
 * That file holds your API key, which is why it lives in your user profile and never
 * in this folder.
 */
const DEFAULTS = {
  hotkey: 'Control+Shift+Space',
  cancelKey: 'Escape',
  launchAtLogin: false,

  pill: {
    show: true,
    bottomMargin: 26,
    // Paste as soon as the text is ready instead of parking it in the pill for a
    // second confirming keypress. The transcript appearing in the chat box IS the
    // confirmation. Set false to get the confirm-then-insert flow back.
    autoInsert: true,
    // Collapse newlines so a multi-line transcript can't auto-submit in a terminal.
    // null = decide per target window; true/false to force.
    collapseNewlines: null,
    // Periodically re-claim the top of the always-on-top band, because another
    // always-on-top app can outrank the pill when focused. Set false if it ever
    // interferes with window switching.
    keepOnTop: true,
  },

  /**
   * Keep every dictation locally as (audio, raw, final text), so accuracy can be
   * measured and improved from real data instead of tuned by hand against whatever
   * sentence broke today. Off by default: it is a recording of everything you say.
   * Nothing reads it at runtime and nothing uploads it.
   */
  corpus: {
    enabled: false,
    // null = %APPDATA%\flowvoice\corpus
    dir: null,
    // ~14 MB per hour of speech; past this the oldest clips are dropped.
    maxMB: 2048,
  },

  /**
   * Voice memos. SECONDARY to dictation: a separate hotkey, and it never touches the
   * caret. Recording a memo only saves the audio. It is transcribed later, and only
   * when you pick "Transcribe memos" from the tray.
   */
  memo: {
    enabled: true,
    hotkey: 'Control+Shift+M',
    // null = %APPDATA%\flowvoice\memos. An absolute path moves the store anywhere.
    dir: null,
    // Latency is irrelevant when nothing is waiting on the text, so buy accuracy.
    model: 'whisper-large-v3',
    timeoutMs: 300000,
    // The provider rejects very large uploads; a clear message beats a confusing 413.
    maxUploadMB: 20,
  },

  stt: {
    provider: 'groq', // groq | openai | elevenlabs | deepgram
    // Paste your key here, or set FLOWVOICE_GROQ_KEY in the environment instead.
    apiKey: '',
    // large-v3, NOT the turbo variant. Turbo buys speed by giving up accuracy, and a
    // non-native accent is exactly where that shows: "voice memo" came back as
    // "Spice Nemo". A correction pass cannot repair a transcript that bad.
    model: 'whisper-large-v3',
    language: 'en',
    // Optional. Names the model would otherwise mangle, comma separated.
    prompt: '',
  },

  /**
   * Second pass over the transcript.
   *
   * Whisper's own `prompt` biases decoding but does not reliably win: it still
   * produced "Claw" for Claude. A chat model reading the finished text fixes that,
   * and unlike the decoder prompt it can also learn, because every change it makes is
   * recorded in lexicon.json and applied next time.
   */
  correction: {
    enabled: true,
    model: 'openai/gpt-oss-120b',
    // Extra request fields for the model. gpt-oss is a reasoning model: left at its
    // default effort it spends the token budget thinking and returns an empty string,
    // so keep effort low and the reasoning out of the reply.
    params: { reasoning_effort: 'low', include_reasoning: false },
    // Blank reuses stt.apiKey (same Groq account).
    apiKey: '',
    timeoutMs: 4000,
    /**
     * Names worth protecting. This list does double duty: it biases the corrector,
     * AND it gates learning (a correction is only remembered when the corrected side
     * lands on one of these).
     *
     * KEEP IT TIGHT, and only include words you actually SAY. Every entry is another
     * thing the model can reach for when it hears something unclear. A stack name you
     * never say out loud has no upside: the corrector will happily turn a misheard
     * ordinary word into it.
     */
    glossary: ['Claude', 'Claude Code', 'GitHub', 'voice', 'voice memo', 'dictation'],
    // How many times a mishearing must repeat before it is treated as this speaker's
    // habit rather than a one-off guess by the corrector.
    promoteAfter: 2,
    maxPromptPairs: 40,
  },
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k] ?? {}, v) : v
  }
  return out
}

class Config {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'config.json')
    this.data = DEFAULTS
  }

  load() {
    try {
      // Strip a BOM: an editor that saves UTF-8 with one would otherwise make the
      // file unparseable, and the catch below would reset it to defaults.
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')
      this.data = deepMerge(DEFAULTS, JSON.parse(raw))
      // Write the merged result straight back so the file on disk always shows the
      // full current schema, including options added in a later version.
      this.save()
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        // Never overwrite a file we failed to parse: it probably holds a key.
        console.error(`[config] could not read ${this.file}: ${err.message}. Using defaults for this run.`)
        this.data = DEFAULTS
        return this.data
      }
      this.data = DEFAULTS
      this.save()
    }
    return this.data
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch {
      /* a read-only profile shouldn't take the app down */
    }
  }

  set(patch) {
    this.data = deepMerge(this.data, patch)
    this.save()
    return this.data
  }
}

module.exports = { Config, DEFAULTS }
