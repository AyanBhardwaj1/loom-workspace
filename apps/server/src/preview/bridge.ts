/**
 * The co-testing bridge, injected into every HTML page the preview serves.
 * It runs inside the sandboxed (opaque-origin) iframe and can only talk to
 * the parent Loom page through postMessage. It reports where this viewer's
 * pointer is, what they click (element role + visible text — never anything
 * typed), which page they're on, their scroll position, and runtime errors
 * their browser hits. The parent validates the sender window, rate-limits,
 * and relays over the authenticated WebSocket. It also accepts two commands
 * from the parent: scroll to a position, open a path — that is follow mode.
 */
export const BRIDGE_JS = `(() => {
  if (window.parent === window || window.__loomBridge) return
  window.__loomBridge = true
  var post = function (m) { try { m.__loom = 1; window.parent.postMessage(m, '*') } catch (e) {} }
  var page = function () { return location.pathname + location.hash }
  var describe = function (el) {
    if (!el || !el.tagName) return ''
    var role = el.getAttribute('role') || el.tagName.toLowerCase()
    var name = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || ''
    if (!name && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') name = (el.textContent || '').replace(/\\s+/g, ' ').trim()
    return (role + (name ? ' · ' + name : '')).slice(0, 120)
  }
  var lastMove = 0, queued = null, timer = 0
  addEventListener('pointermove', function (e) {
    queued = { kind: 'move', x: Math.max(0, e.pageX), y: Math.max(0, e.pageY), path: page() }
    var now = Date.now()
    if (now - lastMove >= 50) { lastMove = now; post(queued); queued = null }
    else if (!timer) timer = setTimeout(function () { timer = 0; if (queued) { lastMove = Date.now(); post(queued); queued = null } }, 50)
  }, { passive: true })
  document.addEventListener('pointerleave', function () { post({ kind: 'leave', path: page() }) })
  addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('a,button,input,select,textarea,label,summary,[role=button],[role=link]') || e.target : e.target
    post({ kind: 'click', x: Math.max(0, e.pageX), y: Math.max(0, e.pageY), path: page(), label: describe(t) })
  }, true)
  var lastScroll = 0
  addEventListener('scroll', function () {
    var now = Date.now()
    if (now - lastScroll < 100) return
    lastScroll = now
    post({ kind: 'scroll', x: Math.max(0, scrollX), y: Math.max(0, scrollY), vw: innerWidth, vh: innerHeight, path: page() })
  }, { passive: true })
  addEventListener('error', function (e) { post({ kind: 'error', message: String(e.message || 'Script error').slice(0, 300), path: page() }) })
  addEventListener('unhandledrejection', function (e) { post({ kind: 'error', message: ('Unhandled promise rejection: ' + String(e.reason && e.reason.message || e.reason)).slice(0, 300), path: page() }) })
  addEventListener('hashchange', function () { post({ kind: 'nav', path: page() }) })
  addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || e.data.__loomCmd === undefined) return
    if (e.data.__loomCmd === 'scrollTo') window.scrollTo({ left: Number(e.data.x) || 0, top: Number(e.data.y) || 0, behavior: 'auto' })
  })
  post({ kind: 'nav', path: page() })
  post({ kind: 'scroll', x: scrollX, y: scrollY, vw: innerWidth, vh: innerHeight, path: page() })
})();
`
