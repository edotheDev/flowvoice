'use strict'
/**
 * Transcript repair.
 *
 * Whisper is good at sounds and bad at proper nouns, and it is worse at both for a
 * non-native accent. A small chat model reading the same text WITH a glossary and
 * this speaker's known mishearings fixes most of that for a few hundred milliseconds
 * and a fraction of a cent.
 *
 * The failure that prompted this:
 *   in   "Hey, Claw. Can you hear my voice?"
 *   out  "Hey, Claude. Can you hear my voice?"
 * The default model is openai/gpt-oss-120b on Groq at low reasoning effort, a few
 * hundred milliseconds. Left at its default effort a reasoning model burns the token
 * budget thinking and emits nothing, which is what `correction.params` is for.
 *
 * Hard rule: this stage may improve a transcript, never destroy one. Every failure
 * path returns the original text.
 */

const { applyKnownFixes } = require('./lexicon')

const URL = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-oss-120b'

/**
 * The prompt has to fight one specific failure: over-applying the glossary.
 * The first version turned "Cessun" into "Claude" because a brand name was the
 * nearest listed token. The rule about common words being misheard as common words
 * is what stops that.
 */
function buildSystem(glossary) {
  const lines = [
    'You repair speech-to-text output. The speaker is a non-native English speaker.',
    '',
    'Rules:',
    '- Fix only words that were clearly MISHEARD by the transcriber.',
    '- Use the glossary ONLY when the misheard word plausibly sounds like a glossary entry.',
    '- A common English word misheard is usually another common English word, not a brand name.',
    "- Keep the speaker's own wording, filler and sentence order. Do not answer, summarise, translate, or add anything.",
    '- Preserve the original capitalisation style for ordinary words.',
    '- If nothing is clearly wrong, return the input unchanged.',
    'Output ONLY the corrected text.',
    '',
    'Glossary: ' + glossary.join(', '),
  ]
  // Known mishearings are deliberately NOT listed here. Stating them as rules made
  // the model generalise: told that "price memo" is "voice memo", it also rewrote
  // "the price of Deepgram" and "demo video". Those are applied in code instead,
  // before this prompt ever runs. See applyKnownFixes in lexicon.js.
  return lines.join('\n')
}

class Corrector {
  constructor(config, lexicon) {
    this.config = config
    this.lexicon = lexicon
  }

  get settings() {
    return this.config.correction || {}
  }

  get enabled() {
    return this.settings.enabled !== false && !!this.key
  }

  // Correction rides on the same Groq account as transcription unless told otherwise.
  get key() {
    const c = this.settings
    const s = this.config.stt || {}
    return c.apiKey || s.apiKey || process.env.FLOWVOICE_GROQ_KEY || ''
  }

  describe() {
    if (this.settings.enabled === false) return 'off'
    if (!this.key) return 'key missing'
    const n = this.lexicon ? this.lexicon.confirmed(this.settings.promoteAfter ?? 2).length : 0
    return `${this.settings.model || DEFAULT_MODEL} (${n} learned)`
  }

  /**
   * @returns {{text: string, changed: boolean, ms: number, error?: string}}
   *   `text` is always safe to use: on any failure it is the input, untouched.
   */
  async fix(text) {
    const started = Date.now()
    const original = String(text || '').trim()
    let input = original
    if (!input) return { text: input, changed: false, ms: 0, known: [] }

    // Deterministic first: known mishearings are a lookup, not a judgement call.
    // This runs even when the LLM pass is disabled or its key is missing.
    const known = this.lexicon ? applyKnownFixes(input, this.lexicon.applicable()) : { text: input, hits: [] }
    input = known.text

    // Every LLM-stage failure falls back to this: the deterministic fixes survive
    // even when the model call does not.
    const bail = () => ({
      text: input,
      changed: input !== original,
      ms: Date.now() - started,
      known: known.hits,
    })

    if (!this.enabled) return bail()

    const c = this.settings
    const glossary = Array.isArray(c.glossary) && c.glossary.length ? c.glossary : []

    // A correction that arrives late is worse than no correction: the whole point of
    // the pill is that dictation lands while you are still thinking.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), c.timeoutMs || 4000)

    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: c.model || DEFAULT_MODEL,
          temperature: 0,
          // Room for the transcript plus slack for a little reasoning.
          max_tokens: Math.max(512, Math.ceil(input.length / 2) + 384),
          ...(c.params && typeof c.params === 'object' ? c.params : {}),
          messages: [
            { role: 'system', content: buildSystem(glossary) },
            { role: 'user', content: input },
          ],
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        return { ...bail(), error: `correct ${res.status}${detail ? ': ' + detail.slice(0, 120) : ''}` }
      }

      const json = await res.json()
      const out = json && json.choices && json.choices[0] && json.choices[0].message
        ? String(json.choices[0].message.content || '').trim()
        : ''

      // Guardrails against a model that decided to be helpful instead of literal.
      // A repair is roughly the same length as its input; anything else is a
      // summary, a refusal, or an answer to what was dictated.
      if (!out) return { ...bail(), error: 'correction empty' }
      if (out.length > input.length * 1.6 + 40 || out.length < input.length * 0.5) {
        return { ...bail(), error: 'correction rejected (length)' }
      }

      // learnFrom/learnTo isolate what the MODEL changed, so the deterministic
      // lookup's own edits are never re-learned as fresh discoveries.
      return {
        text: out,
        changed: out !== original,
        ms: Date.now() - started,
        known: known.hits,
        learnFrom: input,
        learnTo: out,
        // Recorded so the local spend meter can price this call exactly instead of
        // estimating from character counts.
        usage: json && json.usage
          ? { input: json.usage.prompt_tokens || 0, output: json.usage.completion_tokens || 0 }
          : null,
      }
    } catch (err) {
      const why = err && err.name === 'AbortError' ? 'correction timed out' : (err && err.message) || 'correction failed'
      return { ...bail(), error: why }
    } finally {
      clearTimeout(timer)
    }
  }
}

module.exports = { Corrector }
