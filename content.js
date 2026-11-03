// Injected into the active tab. Reads what is on screen and returns a compact snapshot.
// Every interactive element gets a data-lume-id so Lume can act on it.
(() => {
  // The user can ask Lume to read deeper, which raises the limit for the next read
  const deep = Boolean(globalThis.__lumeDeep)
  const MAX_IN_VIEW = deep ? 200 : 90
  const MAX_BELOW = deep ? 40 : 15
  let truncated = false
  const MAX_TEXT = 2500

  const isVisible = (el) => {
    const rect = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }

  const inViewport = (rect) => rect.bottom > 0 && rect.top < window.innerHeight

  // Password and card fields: their content is never read or sent anywhere
  const isSecretField = (el) => {
    const type = (el.type || '').toLowerCase()
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase()
    const name = `${el.name || ''} ${el.id || ''}`.toLowerCase()
    return type === 'password' || autocomplete.startsWith('cc-') || /card|cvv|cvc|ccnum/.test(name)
  }

  // Why this page is off limits for Lume (empty when it is fine)
  const sensitiveReason = () => {
    const secret = [...document.querySelectorAll('input')].find((input) => isSecretField(input) && isVisible(input))
    if (secret) return (secret.type || '').toLowerCase() === 'password' ? 'password field' : 'payment fields'
    if (/(checkout|payment|billing|login|log-in|signin|sign-in|signup|sign-up)/i.test(location.pathname)) return 'login or payment page'
    return ''
  }

  const labelOf = (el) =>
    (
      el.getAttribute('aria-label') ||
      el.innerText ||
      (isSecretField(el) ? '' : el.value) ||
      el.placeholder ||
      el.title ||
      el.alt ||
      el.name ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)

  const roleOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || el.getAttribute('role') === 'button') return 'button'
    if (tag === 'select') return 'dropdown'
    if (tag === 'textarea') return 'text box'
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase()
      if (['submit', 'button'].includes(type)) return 'button'
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio button'
      if (type === 'password') return 'password field'
      return 'text field'
    }
    return el.getAttribute('role') || 'control'
  }

  // Ids from a previous read are stale: clear them so numbers never collide
  document.querySelectorAll('[data-lume-id]').forEach((el) => el.removeAttribute('data-lume-id'))

  // Includes elements wired with data-action, onclick or tabindex: sites like Amazon build Delete and Save for later this way
  // An open pop-up (modal) takes over: read only what is inside it, the page behind is not usable
  // A real modal blocks the page behind it: it is a modal <dialog>, it fills the screen, or a dimmed backdrop covers the page
  const blocksPage = (node) => {
    try {
      if (node.matches(':modal')) return true
    } catch {
      // :modal is not supported in older browsers
    }
    const rect = node.getBoundingClientRect()
    if (rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9) return true
    const probe = document.elementFromPoint(4, 4)
    if (!probe || node.contains(probe)) return false
    for (let el = probe; el && el !== document.documentElement; el = el.parentElement) {
      if (getComputedStyle(el).position !== 'fixed') continue
      const box = el.getBoundingClientRect()
      if (box.width >= window.innerWidth * 0.9 && box.height >= window.innerHeight * 0.9) return true
    }
    return false
  }
  const modal = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal="true"], dialog[open], .a-popover-modal')]
    .filter((node) => isVisible(node) && inViewport(node.getBoundingClientRect()) && blocksPage(node))
    .pop()
  const root = modal || document

  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [data-action], [onclick], [tabindex="0"]'
  const onScreen = []
  const below = []
  root.querySelectorAll(selector).forEach((el) => {
    if (!isVisible(el)) return
    const label = labelOf(el)
    if (!label && !['text field', 'text box'].includes(roleOf(el))) return
    // Skip wrappers that only contain other controls or long text: the inner control is listed instead
    if (roleOf(el) === 'control' && (label.length > 40 || el.querySelector(selector))) return
    const rect = el.getBoundingClientRect()
    if (inViewport(rect)) {
      if (onScreen.length < MAX_IN_VIEW) onScreen.push({ el, label, visible: true })
      else truncated = true
    } else if (rect.top >= window.innerHeight) {
      if (below.length < MAX_BELOW) below.push({ el, label, visible: false })
      else truncated = true
    }
  })

  const elements = [...onScreen, ...below].map(({ el, label, visible }, index) => {
    const id = index + 1
    el.setAttribute('data-lume-id', String(id))
    return { id, role: roleOf(el), label, visible }
  })

  const headings = [...root.querySelectorAll('h1, h2, h3')]
    .filter((h) => isVisible(h) && inViewport(h.getBoundingClientRect()))
    .slice(0, 15)
    .map((h) => h.innerText.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  // Meaningful images on screen (not icons). Lume cannot see them, but their count and alt text still matter.
  const pictures = [...root.querySelectorAll('img, [role=img]')].filter((img) => {
    const rect = img.getBoundingClientRect()
    return isVisible(img) && inViewport(rect) && rect.width >= 80 && rect.height >= 80
  })
  const images = {
    count: pictures.length,
    descriptions: pictures
      .map((img) => (img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60))
      .filter(Boolean)
      .slice(0, 6),
  }

  // Only the text that is on screen right now, so it changes after every scroll
  const walker = document.createTreeWalker(modal || document.body, NodeFilter.SHOW_TEXT)
  const chunks = []
  let length = 0
  while (walker.nextNode() && length < MAX_TEXT) {
    const node = walker.currentNode
    const value = node.textContent.replace(/\s+/g, ' ').trim()
    const parent = node.parentElement
    if (!value || !parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName) || !isVisible(parent)) continue
    if (!inViewport(parent.getBoundingClientRect())) continue
    chunks.push(value)
    length += value.length + 1
  }
  const text = chunks.join(' ').slice(0, MAX_TEXT)

  const scrollable = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
  const scroll = {
    atTop: window.scrollY <= 5,
    atBottom: scrollable - window.scrollY <= 5,
    percent: scrollable ? Math.round((window.scrollY / scrollable) * 100) : 0,
  }

  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || '',
    headings,
    elements,
    images,
    text,
    scroll,
    sensitive: sensitiveReason(),
    truncated,
    deep,
    modal: Boolean(modal),
  }
})()
