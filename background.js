// Service worker: reads the page, describes it, listens to the user and acts on the page for them.

const DEFAULTS = { apiKey: '', model: 'claude-haiku-5-5', lang: 'en', bargeIn: true, bargeLevel: 'low', voiceName: '', rate: '0.9' }

// How loud (0 to 1) the user must be to interrupt Lume
const BARGE_THRESHOLDS = { low: 0.05, medium: 0.025, high: 0.01 }

const MAX_STEPS = 6

const SYSTEM_PROMPT = `You are Lume, a warm, friendly companion who sits next to a blind person and does things on their screen for them.
You receive a snapshot of the current web page. Every control has an id like [12].

First message: give a very short introduction, like a friend glancing at the screen. In two or three short sentences: say where they are (kind of page), then name the main blocks of content on screen, not just the controls. Blocks are things like a search box, a row of images, an overview or summary, a weather box, a list of results, a form. If there are images, always say there are images on screen. Then ask if they want more detail about any of them. Never read the whole page, and stay under 40 words.
Examples:
"You are on a search page. The main element is a text box to search, and you have the options Search and I'm Feeling Lucky. There are other elements, but they look less relevant. Do you want me to describe them?"
"You are on Google results for Austin Texas. I see a group of images, a short overview of the city, a weather box, and below that the list of results. Do you want more detail on any of them?"
You cannot see the images themselves, only their alt text if it exists. Say what the alt text tells you, and if there is none, say you cannot tell what they show.
Only describe more when the user asks for it.

After that the user talks to you:
- The snapshot shows only what is on screen right now, plus a few controls marked "below the screen". If what the user wants is probably further down, scroll and read again on your own, without asking, and say so in a few words ("let me scroll down"). Do not scroll if the snapshot says you are at the bottom.
- If the snapshot says the controls list is INCOMPLETE and you cannot find what the user wants, do not guess. Say there is a limit on how much you read and ask if they want you to search deeper, in one short sentence. Only if they agree, call read_more.
- If they ask a question, answer it from the snapshot.
- If they ask you to do something, do it with your tools: click, type_text, scroll, go_back. Before acting, say one short sentence about what you are doing. For a search, type the text into the search field with press_enter set to true.
- After your actions you receive the new page. Summarize the result in one or two short sentences (what kind of results, roughly how many) and ask what they want next, for example if they are looking for something specific such as a price. Do not read the results one by one unless asked.
- If you need a choice the user has not made, ask instead of guessing.
- HARD RULE: you never take part in passwords, logins or purchases. When the snapshot says SENSITIVE PAGE, or the user asks you to log in, enter a password, enter card details, pay, buy, place an order or confirm a purchase, do not use click or type_text at all. Say, in one short sentence, that this part is for them to do and that you will wait, and offer to keep helping once they finish. You may still describe the page and scroll.
Rules: speak in the user's language, short sentences, no lists, no symbols, no markdown, no URLs read aloud. Keep every answer short: 40 words at most unless the user asks for details.`

const TOOLS = [
  {
    name: 'click',
    description: 'Click a button, link or other control by its id.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'type_text',
    description: 'Type text into a text field by its id. Set press_enter to true to submit, for example a search.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, text: { type: 'string' }, press_enter: { type: 'boolean' } },
      required: ['id', 'text'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page down or up by about one screen.',
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } }, required: ['direction'] },
  },
  {
    name: 'read_more',
    description: 'Read the current screen again with a much higher limit of controls. Use it only after the user agrees to a deeper search.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'go_back',
    description: 'Go back to the previous page.',
    input_schema: { type: 'object', properties: {} },
  },
]

// Phrases that end the conversation
const EXIT_WORDS = /\b(stop|bye|goodbye|that's all|thank you|thanks|adiós|adios|gracias|eso es todo|ya está|ya esta)\b/i

const SNAPSHOT_MARK = 'PAGE SNAPSHOT'

const state = { active: false, tabId: null, deepRead: false, pendingListen: null, onSpeechStart: null, tabChanged: false, voiceName: undefined, rate: 0.9, bargeThreshold: BARGE_THRESHOLDS.low }

const t = (lang, en, es) => (lang === 'es' ? es : en)
const voiceLang = (lang) => (lang === 'es' ? 'es-US' : 'en-US')
const getSettings = () => chrome.storage.local.get(DEFAULTS).then((s) => ({ ...DEFAULTS, ...s }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Follow the user to whichever tab becomes active, for example when a link opens in a new tab
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!state.active || tabId === state.tabId) return
  state.tabId = tabId
  state.tabChanged = true
})

// Picks the most natural installed voice for the language. Premium/enhanced voices sound far
// less robotic; they can be downloaded in macOS System Settings > Accessibility > Spoken Content.
async function pickVoice(lang) {
  const voices = await chrome.tts.getVoices()
  const candidates = voices.filter((voice) => (voice.lang || '').toLowerCase().startsWith(lang))
  const score = (voice) => {
    const name = voice.voiceName.toLowerCase()
    const region = (voice.lang || '').toLowerCase()
    let points = 0
    if (/premium|enhanced|neural|natural/.test(name)) points += 10
    if (/google/.test(name)) points += 5
    if (/samantha|ava|allison|nicky|zoe|serena|paulina|monica|mónica|marisol|jorge/.test(name)) points += 3
    if (['en-us', 'es-us', 'es-mx'].includes(region.replace('_', '-'))) points += 1
    if (/compact|novelty|bad news|good news|bells|boing|whisper|zarvox|trinoids|albert|fred|junior|kathy|ralph|organ|cellos|bubbles|superstar|wobble/.test(name)) points -= 20
    return points
  }
  const best = candidates.sort((a, b) => score(b) - score(a))[0]
  return best ? best.voiceName : undefined
}

// Queues the text and resolves when the voice finishes it (or is interrupted)
const speak = (text, lang) =>
  new Promise((resolve) => {
    chrome.tts.speak(text, {
      lang: voiceLang(lang),
      ...(state.voiceName ? { voiceName: state.voiceName } : {}),
      rate: state.rate,
      pitch: 1,
      enqueue: true,
      onEvent: (event) => {
        if (['end', 'interrupted', 'cancelled', 'error'].includes(event.type)) resolve()
      },
    })
  })

// ---- Reading the page ----

async function readPage(tabId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (deep) => {
          globalThis.__lumeDeep = deep
        },
        args: [state.deepRead],
      })
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      if (result && result.result) return result.result
    } catch {
      // The page may still be loading after an action
    }
    await sleep(600)
  }
  return null
}

function buildSnapshot(page) {
  return [
    SNAPSHOT_MARK,
    `Title: ${page.title}`,
    `Page language: ${page.lang || 'unknown'}`,
    `Scroll position: ${page.scroll.percent}%${page.scroll.atTop ? ' (top)' : ''}${page.scroll.atBottom ? ' (bottom: nothing more below)' : ' (more content below)'}`,
    page.modal ? 'POP-UP OPEN: a pop-up window is open on top of the page. The controls and text below are only the ones inside it. Tell the user about it in a few words and help them with it first.' : 'Pop-up: none',
    page.truncated ? 'Controls list is INCOMPLETE: this page has more controls than the limit allows, so the one the user wants may be missing.' : 'Controls list: complete',
    page.sensitive ? `SENSITIVE PAGE (${page.sensitive}): do not click or type here. The user must handle it themselves.` : 'Sensitive page: no',
    `Headings on screen: ${page.headings.join(' | ')}`,
    `Controls: ${page.elements.map((e) => `[${e.id}] ${e.role}: ${e.label}${e.visible ? '' : ' (below the screen)'}`).join('; ')}`,
    `Images on screen: ${page.images.count}${page.images.descriptions.length ? ` (alt text: ${page.images.descriptions.join(' | ')})` : ' (no descriptions available)'}`,
    `Text on screen: ${page.text}`,
  ].join('\n')
}

// Old snapshots are stale and expensive: keep only the newest one in the history
function pruneSnapshots(history) {
  history.slice(0, -1).forEach((message) => {
    if (!Array.isArray(message.content)) return
    message.content.forEach((block) => {
      if (block.type === 'text' && block.text.includes(SNAPSHOT_MARK)) block.text = `${SNAPSHOT_MARK} (outdated, removed)`
    })
  })
}

// Used when there is no API key: a plain, local description
function localDescription(page, lang) {
  const links = page.elements.filter((e) => e.role === 'link').length
  const buttons = page.elements.filter((e) => e.role === 'button').length
  const fields = page.elements.filter((e) => /text|password/.test(e.role)).length
  if (lang === 'es') {
    return `Estás en ${page.title || 'una página sin título'}. Tiene ${links} enlaces, ${buttons} botones y ${fields} campos de texto. ${
      page.headings.length ? 'Los títulos principales son: ' + page.headings.slice(0, 4).join(', ') + '.' : ''
    } Agrega tu clave de la API en las opciones para una descripción más completa.`
  }
  return `You are on ${page.title || 'an untitled page'}. It has ${links} links, ${buttons} buttons and ${fields} text fields. ${
    page.headings.length ? 'Main headings: ' + page.headings.slice(0, 4).join(', ') + '.' : ''
  } Add your API key in the options for a fuller description.`
}

// ---- Model ----

// Overloaded or rate-limited responses are usually temporary, so those are retried
const RETRY_STATUSES = [429, 500, 502, 503, 529]

async function callModel(settings, messages) {
  const body = JSON.stringify({
    model: settings.model,
    max_tokens: 400,
    thinking: { type: 'disabled' },
    system: `${SYSTEM_PROMPT}\nRespond in: ${settings.lang === 'es' ? 'Spanish' : 'English'}.`,
    tools: TOOLS,
    messages,
  })

  for (let attempt = 1; ; attempt += 1) {
    let response
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body,
      })
    } catch (error) {
      if (attempt >= 3) throw new Error(`Network error: ${error.message}`)
      await sleep(1000 * attempt)
      continue
    }

    if (response.ok) return response.json()

    const detail = (await response.text()).slice(0, 300)
    if (RETRY_STATUSES.includes(response.status) && attempt < 3) {
      await sleep(1500 * attempt)
      continue
    }
    throw new Error(`API ${response.status}: ${detail}`)
  }
}

// A short spoken reason for the failure, and the full error in the service worker console
function explainError(error, lang) {
  console.error('Lume error:', error)
  const message = String(error && error.message)
  if (message.includes('API 401')) return t(lang, 'My API key is not valid. Check it in the options.', 'La clave de la API no es válida. Revísala en las opciones.')
  if (message.includes('API 429')) return t(lang, 'Too many requests. Give me a few seconds and try again.', 'Demasiadas solicitudes. Espera unos segundos e inténtalo de nuevo.')
  if (message.includes('API 529') || message.includes('API 5')) return t(lang, 'The service is busy right now. Try again in a moment.', 'El servicio está ocupado. Inténtalo en un momento.')
  if (message.includes('Network')) return t(lang, 'I cannot reach the internet.', 'No tengo conexión a internet.')
  return t(lang, 'Sorry, something went wrong. Try again.', 'Lo siento, algo salió mal. Intenta de nuevo.')
}

const textOf = (content) =>
  content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .trim()

// ---- Acting on the page ----

// Runs inside the page, so it must be self-contained
function performAction(name, input) {
  const BLOCKED_CLICK = /\b(buy|buy now|purchase|pay|pay now|checkout|check out|place order|place your order|order now|confirm order|complete order|subscribe|log in|login|sign in|delete|remove account|comprar|pagar|pedir|finalizar compra|iniciar sesión|eliminar)\b/i
  // On a shopping cart page, delete only removes items, so it is allowed there
  const BLOCKED_IN_CART = /\b(buy|buy now|purchase|pay|pay now|checkout|check out|place order|place your order|order now|confirm order|complete order|subscribe|log in|login|sign in|remove account|comprar|pagar|pedir|finalizar compra|iniciar sesión)\b/i
  const inCart = /(cart|basket|bag|carrito)/i.test(location.pathname)

  if (name === 'scroll') {
    const amount = Math.round(window.innerHeight * 0.8)
    window.scrollBy({ top: input.direction === 'up' ? -amount : amount, behavior: 'instant' })
    return `Scrolled ${input.direction}.`
  }

  if (name === 'go_back') {
    history.back()
    return 'Went back.'
  }

  // Last line of defense, independent of what the model decides: no clicking or typing on login or payment pages
  const isShown = (node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
  }
  const hasSecretField = [...document.querySelectorAll('input')].some((node) => {
    const type = (node.type || '').toLowerCase()
    const autocomplete = (node.getAttribute('autocomplete') || '').toLowerCase()
    const name = `${node.name || ''} ${node.id || ''}`.toLowerCase()
    return (type === 'password' || autocomplete.startsWith('cc-') || /card|cvv|cvc|ccnum/.test(name)) && isShown(node)
  })
  if (hasSecretField || /(checkout|payment|billing|login|log-in|signin|sign-in|signup|sign-up)/i.test(location.pathname)) {
    return 'Blocked: this is a login or payment page. The user must handle it themselves.'
  }

  const el = document.querySelector(`[data-lume-id="${input.id}"]`)
  if (!el) return 'Error: that element is not on the page anymore.'

  if (name === 'click') {
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || '').trim()
    if ((inCart ? BLOCKED_IN_CART : BLOCKED_CLICK).test(label)) return 'Blocked: the user must press this one themselves.'
    el.scrollIntoView({ block: 'center' })
    el.click()
    return `Clicked "${label.slice(0, 60)}".`
  }

  if (name === 'type_text') {
    const type = (el.type || '').toLowerCase()
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()
    if (type === 'password' || autocomplete.startsWith('cc-')) return 'Blocked: the user must fill this field themselves.'

    el.focus()
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, input.text)
    else el.value = input.text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))

    if (input.press_enter) {
      const keyInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
      const notHandled = el.dispatchEvent(new KeyboardEvent('keydown', keyInit))
      el.dispatchEvent(new KeyboardEvent('keyup', keyInit))
      // If the page did not handle Enter itself, submit the form
      if (notHandled && el.form) {
        if (el.form.requestSubmit) el.form.requestSubmit()
        else el.form.submit()
      }
    }
    return `Typed "${input.text}"${input.press_enter ? ' and pressed Enter' : ''}.`
  }

  return 'Error: unknown action.'
}

async function runAction(tabId, toolUse) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: performAction,
      args: [toolUse.name, toolUse.input || {}],
    })
    return String(result.result)
  } catch {
    return 'Error: could not act on this page.'
  }
}

// Waits for a navigation or dynamic update triggered by an action to finish
async function settle(tabId) {
  await sleep(700)
  for (let i = 0; i < 16; i += 1) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab || tab.status === 'complete') break
    await sleep(500)
  }
  await sleep(500)
}

// One user turn: let the model act as many times as it needs, then return what it says
async function respond(settings, history) {
  for (let step = 0; step < MAX_STEPS && state.active; step += 1) {
    const data = await callModel(settings, history)
    // Thinking blocks are signed to the exact conversation, so they are never sent back
    const kept = data.content.filter((block) => block.type === 'text' || block.type === 'tool_use')
    history.push({ role: 'assistant', content: kept.length ? kept : [{ type: 'text', text: 'Okay.' }] })

    const toolUses = data.content.filter((block) => block.type === 'tool_use')
    const text = textOf(data.content)
    if (!toolUses.length) return text

    // Say what is about to happen while the actions run
    if (text) speak(text, settings.lang)

    const results = []
    // The deeper read lasts only for the next page read
    state.deepRead = toolUses.some((toolUse) => toolUse.name === 'read_more')
    for (const toolUse of toolUses) {
      const result = toolUse.name === 'read_more' ? 'Reading the page more deeply.' : await runAction(state.tabId, toolUse)
      results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: result })
    }

    await settle(state.tabId)
    const page = await readPage(state.tabId)
    const tabNote = state.tabChanged ? 'A new tab opened and you are now on it. The previous page is still open in another tab.\n' : ''
    state.tabChanged = false
    results.push({
      type: 'text',
      text: tabNote + (page ? buildSnapshot(page) : `${SNAPSHOT_MARK}\n(The page could not be read right now.)`),
    })
    history.push({ role: 'user', content: results })
    pruneSnapshots(history)
  }
  return t(settings.lang, 'I did what I could. What would you like next?', 'Hice lo que pude. ¿Qué quieres hacer ahora?')
}

// ---- Microphone (runs in an offscreen document: service workers cannot listen) ----

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Listen to the user with the microphone',
  })
}

// Resolves with { text, error } once the user spoke, stayed silent or the mic failed.
// With barge set, it listens while Lume is talking and reports when the user starts speaking.
async function listen(lang, { barge = false } = {}) {
  await ensureOffscreen()
  return new Promise((resolve) => {
    state.pendingListen = resolve
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'listen', lang: voiceLang(lang), barge, threshold: state.bargeThreshold })
  })
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'background') return
  if (message.type === 'speechstart') {
    if (state.onSpeechStart) state.onSpeechStart(message.text || '', message.loud !== false)
    return
  }
  if (message.type !== 'heard') return
  const resolve = state.pendingListen
  state.pendingListen = null
  if (resolve) resolve({ text: message.text || '', error: message.error || '' })
})

function abortListen() {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => {})
  if (state.pendingListen) {
    state.pendingListen({ text: '', error: 'aborted' })
    state.pendingListen = null
  }
}

function stopSession() {
  state.active = false
  chrome.tts.stop()
  abortListen()
}

// Speaks the text while listening, so the user can interrupt by talking.
// Returns what the user said if they interrupted, or null if Lume finished speaking.
async function speakAndWatch(text, lang, bargeIn) {
  if (!bargeIn) {
    await speak(text, lang)
    return null
  }

  const normalize = (value) => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
  const spoken = normalize(text)

  let barged = false
  let done = false
  state.onSpeechStart = (heardText, loud) => {
    if (barged) return
    const heard = normalize(heardText)
    // Ignore quiet sounds, noise (too short) and Lume's own voice picked up by the microphone
    const reason = !loud ? 'too quiet' : heard.length < 6 ? 'too short' : spoken.includes(heard) ? 'echo of Lume' : ''
    if (reason) return
    barged = true
    chrome.tts.stop()
  }
  const speaking = speak(text, lang).then(() => {
    done = true
    if (!barged) abortListen()
  })

  let heard = null
  while (state.active && !(done && !barged)) {
    const result = await listen(lang, { barge: true })
    if (!state.active) break
    if (barged) {
      heard = result
      break
    }
    if (done) break
    // A real microphone problem: stop watching instead of retrying in a loop
    if (result.error && !['no-speech', 'aborted'].includes(result.error)) break
  }

  state.onSpeechStart = null
  await speaking
  return heard
}

// ---- Session ----

async function startSession() {
  const settings = await getSettings()
  const lang = settings.lang
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !tab.id) return

  // A saved voice from another language would read English text, and numbers, with the wrong accent
  const voices = await chrome.tts.getVoices()
  const saved = voices.find((voice) => voice.voiceName === settings.voiceName)
  const matches = saved && (saved.lang || '').toLowerCase().startsWith(lang)
  state.voiceName = matches ? settings.voiceName : await pickVoice(lang)
  state.rate = parseFloat(settings.rate) || 0.9
  state.bargeThreshold = BARGE_THRESHOLDS[settings.bargeLevel] ?? BARGE_THRESHOLDS.low
  state.active = true
  state.tabId = tab.id

  const page = await readPage(tab.id)
  if (!page) {
    state.active = false
    speak(t(lang, 'I cannot read this page.', 'No puedo leer esta página.'), lang)
    return
  }


  // Without an API key there is no conversation: just the basic description
  if (!settings.apiKey) {
    await speak(localDescription(page, lang), lang)
    state.active = false
    return
  }

  speak(t(lang, 'Reading the page.', 'Leyendo la página.'), lang)

  const history = [{ role: 'user', content: [{ type: 'text', text: `${buildSnapshot(page)}\n\nGive the short introduction.` }] }]

  let description
  try {
    const data = await callModel(settings, history)
    description = textOf(data.content)
  } catch {
    description = localDescription(page, lang)
  }
  if (!state.active) return

  history.push({ role: 'assistant', content: description })
  chrome.tts.stop()
  // If the user interrupts while Lume talks, that utterance is used instead of listening again
  let interruption = await speakAndWatch(description, lang, settings.bargeIn)

  let silences = 0
  let failures = 0
  while (state.active) {
    const { text, error } = interruption || (await listen(lang))
    interruption = null
    if (!state.active) break

    if (error === 'not-allowed' || error === 'service-not-allowed') {
      await speak(
        t(lang, 'I need microphone access. Opening the options page so you can allow it.', 'Necesito acceso al micrófono. Abriendo las opciones para que lo permitas.'),
        lang,
      )
      chrome.runtime.openOptionsPage()
      break
    }

    if (!text) {
      silences += 1
      if (silences >= 2) {
        await speak(t(lang, 'I am here whenever you need me.', 'Aquí estoy cuando me necesites.'), lang)
        break
      }
      continue
    }
    silences = 0

    if (EXIT_WORDS.test(text)) {
      await speak(t(lang, 'Okay, see you.', 'De acuerdo, hasta luego.'), lang)
      break
    }

    // If anything fails, roll the history back so it stays valid for the next turn
    const mark = history.length
    history.push({ role: 'user', content: text })
    let reply
    let failed = false
    try {
      reply = await respond(settings, history)
    } catch (error) {
      history.length = mark
      reply = explainError(error, lang)
      failed = true
    }
    if (!state.active) break

    if (failed) {
      // Errors are spoken without listening for interruptions, so Lume cannot hear its own
      // error message and answer it. Two failures in a row end the session.
      failures += 1
      await speak(reply, lang)
      if (failures >= 2) {
        await speak(t(lang, 'I am stopping for now. Press the shortcut to start again.', 'Me detengo por ahora. Pulsa el atajo para empezar de nuevo.'), lang)
        break
      }
      continue
    }

    failures = 0
    interruption = await speakAndWatch(reply, lang, settings.bargeIn)
  }

  state.active = false
}

// The shortcut starts the session, and stops it if it is already running
function toggleSession() {
  if (state.active) stopSession()
  else startSession()
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'describe-page') toggleSession()
})

chrome.action.onClicked.addListener(toggleSession)

// Open the options page on first install so the user can add the API key
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage()
})
