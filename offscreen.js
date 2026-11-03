// Offscreen document: listens with the microphone and reports what the user said.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
let recognition = null

const report = (payload) => chrome.runtime.sendMessage({ target: 'background', type: 'heard', ...payload })

// A short tone tells a blind user that Lume is now listening
function beep() {
  const ctx = new AudioContext()
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.frequency.value = 880
  gain.gain.value = 0.15
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start()
  oscillator.stop(ctx.currentTime + 0.12)
  oscillator.onended = () => ctx.close()
}

// Measures how loud the user is, so a loud voice can tell apart from background noise.
// `peak` is the recent loudness (RMS, 0 to 1) and fades over about half a second.
let meter = null

async function startMeter() {
  stopMeter()
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    const ctx = new AudioContext()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    ctx.createMediaStreamSource(stream).connect(analyser)
    const samples = new Float32Array(analyser.fftSize)
    const current = { stream, ctx, peak: 0, timer: 0 }
    current.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const value of samples) sum += value * value
      current.peak = Math.max(Math.sqrt(sum / samples.length), current.peak * 0.9)
    }, 50)
    meter = current
  } catch {
    meter = null
  }
}

function stopMeter() {
  if (!meter) return
  clearInterval(meter.timer)
  meter.stream.getTracks().forEach((track) => track.stop())
  meter.ctx.close()
  meter = null
}

function discard() {
  stopMeter()
  if (!recognition) return
  recognition.onresult = recognition.onerror = recognition.onend = null
  recognition.abort()
  recognition = null
}

// barge: Lume is talking right now, so there is no tone and the first words heard count as an interruption
function listen(lang, barge, threshold) {
  if (!Recognition) {
    report({ text: '', error: 'unsupported' })
    return
  }

  discard()
  const current = new Recognition()
  recognition = current
  current.lang = lang
  current.interimResults = barge
  current.maxAlternatives = 1

  let finished = false
  const finish = (payload) => {
    if (finished) return
    finished = true
    stopMeter()
    report(payload)
  }

  current.onresult = (event) => {
    const last = event.results[event.results.length - 1]
    const transcript = last[0].transcript.trim()
    // The background decides if this is a real interruption (loud enough, not noise or echo)
    if (barge) {
      const loud = meter ? meter.peak >= threshold : true
      chrome.runtime.sendMessage({ target: 'background', type: 'speechstart', text: transcript, loud })
    }
    if (last.isFinal) finish({ text: transcript })
  }
  current.onerror = (event) => finish({ text: '', error: event.error })
  current.onend = () => finish({ text: '' })

  const start = () => {
    try {
      current.start()
    } catch {
      finish({ text: '', error: 'start-failed' })
    }
  }

  if (barge) {
    startMeter()
    start()
    return
  }

  beep()
  // Wait for the tone to finish so the microphone does not pick it up
  setTimeout(start, 200)
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return
  if (message.type === 'listen') listen(message.lang, Boolean(message.barge), message.threshold)
  if (message.type === 'stop') discard()
})
