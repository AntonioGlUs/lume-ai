const fields = ['apiKey', 'model', 'lang', 'voiceName', 'rate', 'bargeLevel']
const defaults = { apiKey: '', model: 'claude-haiku-5-5', lang: 'en', bargeIn: true, bargeLevel: 'low', voiceName: '', rate: '0.9' }

const voiceSelect = document.getElementById('voiceName')

// Fill the voice list with the voices installed on this computer
async function loadVoices() {
  const voices = await chrome.tts.getVoices()
  const automatic = new Option('Automatic (best available)', '')
  voiceSelect.append(automatic)
  voices
    .filter((voice) => /^(en|es)/i.test(voice.lang || ''))
    .sort((a, b) => a.voiceName.localeCompare(b.voiceName))
    .forEach((voice) => voiceSelect.append(new Option(`${voice.voiceName} (${voice.lang})`, voice.voiceName)))
}

async function init() {
  await loadVoices()
  const saved = await chrome.storage.local.get(defaults)
  fields.forEach((id) => {
    document.getElementById(id).value = saved[id]
  })
  document.getElementById('bargeIn').checked = saved.bargeIn
}
init()

document.getElementById('testVoice').addEventListener('click', () => {
  const lang = document.getElementById('lang').value
  chrome.tts.stop()
  chrome.tts.speak(
    lang === 'es' ? 'Hola, soy Lume. Estoy aquí para ayudarte a navegar.' : 'Hi, I am Lume. I am here to help you get around.',
    {
      lang: lang === 'es' ? 'es-US' : 'en-US',
      ...(voiceSelect.value ? { voiceName: voiceSelect.value } : {}),
      rate: parseFloat(document.getElementById('rate').value) || 0.9,
    },
  )
})

// The microphone permission has to be granted from a visible extension page
document.getElementById('mic').addEventListener('click', async () => {
  const status = document.getElementById('micStatus')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stream.getTracks().forEach((track) => track.stop())
    status.textContent = 'Microphone allowed.'
  } catch {
    status.textContent = 'Microphone blocked. Allow it in the Chrome site settings for this extension.'
  }
})

document.getElementById('save').addEventListener('click', async () => {
  const values = Object.fromEntries(fields.map((id) => [id, document.getElementById(id).value.trim()]))
  values.bargeIn = document.getElementById('bargeIn').checked
  await chrome.storage.local.set(values)
  const status = document.getElementById('status')
  status.textContent = 'Saved'
  setTimeout(() => (status.textContent = ''), 2000)
})
