import { describe, expect, it } from 'vitest'
import { changedSymbols, changesBetween, symbolsOf, testMerge } from '../src/coord/engine'

const JS = `import x from 'y'

export function renderHero(el) {
  el.title = 'Hi'
  return el
}

const submitForm = async (e) => {
  e.preventDefault()
  send()
}

class Cart {
  add(item) {
    this.items.push(item)
  }
  total() {
    return 0
  }
}
`

describe('coordination engine', () => {
  it('outlines functions, arrow consts, classes and methods; CSS rules; HTML sections', () => {
    expect(symbolsOf('app.js', JS).map((s) => s.name)).toEqual(['renderHero', 'submitForm', 'Cart', 'add()', 'total()'])
    expect(symbolsOf('styles.css', '.hero {\n  color: red;\n}\n@media (max-width: 600px) {\n  .hero { color: blue; }\n}\n').map((s) => s.name)).toEqual(['.hero', '@media (max-width: 600px)'])
    expect(symbolsOf('index.html', '<main>\n<section id="hero">\n<h1>x</h1>\n</section>\n<footer class="site-footer">\n</footer>\n').map((s) => s.name)).toEqual(['<main>', '#hero', 'footer.site-footer'])
  })

  it('names the symbols a change touches', () => {
    const edited = JS.replace("el.title = 'Hi'", "el.title = 'Hello'")
    expect(changedSymbols('app.js', JS, edited)).toEqual(['renderHero'])
    const added = JS.replace('  total() {', '  clear() {\n    this.items = []\n  }\n  total() {')
    expect(changedSymbols('app.js', JS, added)).toContain('clear()')
  })

  it('test-merges: different functions fit; the same function conflicts, by name', () => {
    const base = new Map([['app.js', JS]])
    const ours = new Map([['app.js', JS.replace("el.title = 'Hi'", "el.title = 'Hello'")]])
    const theirs = new Map([['app.js', JS.replace('return 0', 'return this.items.length')]])
    const fit = testMerge(base, ours, theirs)
    expect(fit.clean).toBe(true)
    expect(fit.merged.get('app.js')).toContain("el.title = 'Hello'")
    expect(fit.merged.get('app.js')).toContain('return this.items.length')

    const clash = testMerge(base, ours, new Map([['app.js', JS.replace("el.title = 'Hi'", "el.title = 'Welcome'")]]))
    expect(clash.clean).toBe(false)
    expect(clash.conflicts).toEqual([{ path: 'app.js', symbols: ['renderHero'] }])
  })

  it('attributes a conflicting insertion at the end of a file to the last symbol', () => {
    const css = '.hero {\n  color: red;\n}\n.cta {\n  color: blue;\n}\n'
    const r = testMerge(new Map([['s.css', css]]), new Map([['s.css', css + '.features {\n}\n']]), new Map([['s.css', css + '.footer {\n}\n']]))
    expect(r.conflicts).toEqual([{ path: 's.css', symbols: ['.cta'] }])
  })

  it('summarizes a branch’s changes per file', () => {
    const base = new Map([['app.js', JS], ['old.txt', 'x']])
    const next = new Map([['app.js', JS.replace('send()', 'send(); track()')], ['new.css', '.a {\n}\n']])
    expect(changesBetween(base, next)).toEqual([
      { path: 'app.js', kind: 'edit', symbols: ['submitForm'] },
      { path: 'new.css', kind: 'create', symbols: [] },
      { path: 'old.txt', kind: 'delete', symbols: [] },
    ])
  })
})
