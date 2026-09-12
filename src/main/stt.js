'use strict'
/**
 * Speech-to-text. Provider-agnostic: give it webm/opus bytes, get text back.
 *
 * Every provider here accepts webm/opus directly, so the MediaRecorder output goes
 * up as-is, no ffmpeg transcode in the hot path.
 */

const PROVIDERS = {
  groq: {
    label: 'Groq (whisper-large-v3-turbo)',
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
    auth: key => ({ Authorization: `Bearer ${key}` }),
    form: (fd, cfg) => {
      fd.append('model', cfg.model)
      fd.append('response_format', 'json')
      if (cfg.language) fd.append('language', cfg.language)
      if (cfg.prompt) fd.append('prompt', cfg.prompt)
    },
    parse: j => j.text,
  },

  openai: {
    label: 'OpenAI (gpt-4o-mini-transcribe)',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'gpt-4o-mini-transcribe',
    auth: key => ({ Authorization: `Bearer ${key}` }),
    form: (fd, cfg) => {
      fd.append('model', cfg.model)
      fd.append('response_format', 'json')
      if (cfg.language) fd.append('language', cfg.language)
      if (cfg.prompt) fd.append('prompt', cfg.prompt)
    },
    parse: j => j.text,
  },

  elevenlabs: {
    label: 'ElevenLabs (scribe_v1)',
    url: 'https://api.elevenlabs.io/v1/speech-to-text',
    model: 'scribe_v1',
    auth: key => ({ 'xi-api-key': key }),
    form: (fd, cfg) => {
      fd.append('model_id', cfg.model)
      fd.append('tag_audio_events', 'false')
      if (cfg.language) fd.append('language_code', cfg.language)
    },
    // ElevenLabs uses `file` rather than `audio` as the part name.
    fileField: 'file',
    parse: j => j.text,
  },

  deepgram: {
    label: 'Deepgram (nova-3)',
    url: 'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true',
    auth: key => ({ Authorization: `Token ${key}` }),
    raw: true, // Deepgram takes the audio body directly, not multipart
    parse: j => {
      const alt = j && j.results && j.results.channels && j.results.channels[0]
      return alt && alt.alternatives && alt.alternatives[0] ? alt.alternatives[0].transcript : ''
    },
  },
}

const DEFAULT_FILE_FIELD = 'file'

class Transcriber {
  constructor(config) {
    this.config = config
  }

  get provider() {
    return this.config.stt && this.config.stt.provider
  }

  get key() {
    const s = this.config.stt || {}
    return s.apiKey || process.env[`FLOWVOICE_${String(s.provider || '').toUpperCase()}_KEY`] || ''
  }

  describe() {
    const p = PROVIDERS[this.provider]
    if (!p) return 'not configured'
    return this.key ? p.label : `${p.label} (key missing)`
  }

  /**
   * @param {Uint8Array} bytes
   * @param {{model?: string, timeoutMs?: number}} [opts] Per-call overrides. Memos use
   *   a slower, more accurate model and a much longer timeout: nothing is waiting on
   *   the result, so there is no reason to buy speed with accuracy there.
   */
  async transcribe(bytes, opts = {}) {
    const spec = PROVIDERS[this.provider]
    if (!spec) {
      return { ok: false, error: 'no speech provider set' }
    }
    const key = this.key
    if (!key) {
      return { ok: false, error: `${this.provider} key missing` }
    }

    const cfg = {
      model: opts.model || (this.config.stt && this.config.stt.model) || spec.model,
      language: this.config.stt && this.config.stt.language,
      prompt: this.config.stt && this.config.stt.prompt,
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 30000)

    try {
      let body
      const headers = { ...spec.auth(key) }

      if (spec.raw) {
        body = Buffer.from(bytes)
        headers['Content-Type'] = 'audio/webm'
      } else {
        const fd = new FormData()
        const field = spec.fileField || DEFAULT_FILE_FIELD
        fd.append(field, new Blob([bytes], { type: 'audio/webm' }), 'speech.webm')
        spec.form(fd, cfg)
        body = fd
      }

      const res = await fetch(spec.url, { method: 'POST', headers, body, signal: controller.signal })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        // Two audiences: `error` is what fits in the pill, `detail` is the untruncated
        // body for the log. Reading a provider's 400 is impossible from 120 chars.
        return {
          ok: false,
          status: res.status,
          error: `${this.provider} ${res.status}${detail ? ': ' + detail.slice(0, 120) : ''}`,
          detail,
        }
      }
      const json = await res.json()
      const text = spec.parse(json) || ''
      return { ok: true, text }
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, error: 'transcription timed out' }
      return { ok: false, error: err.message || 'network error' }
    } finally {
      clearTimeout(timeout)
    }
  }
}

module.exports = { Transcriber, PROVIDERS }
