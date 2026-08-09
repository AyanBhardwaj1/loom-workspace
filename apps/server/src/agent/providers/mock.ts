import type { AgentProvider, AgentStreamItem, AgentTurnContext } from '@loom/shared'
import { slugify } from '@loom/shared'

/**
 * Deterministic scripted provider: the entire product works with zero API
 * keys. It streams plausible narrated responses word-by-word with small
 * randomized delays, and makes REAL file edits through the same tool-call
 * pathway as the Anthropic provider — every event type downstream (tool
 * calls, diffs, commits) is exercised honestly.
 */
export class MockAgentProvider implements AgentProvider {
  constructor(private opts: { fast?: boolean } = {}) {}

  async *runTurn(ctx: AgentTurnContext): AsyncIterable<AgentStreamItem> {
    const say = this.makeSpeaker(ctx.signal)
    const parts: string[] = []
    const speak = async function* (this: MockAgentProvider, text: string): AsyncIterable<AgentStreamItem> {
      parts.push(text)
      yield* say(text)
    }.bind(this)

    try {
      const playbook = pickPlaybook(ctx)
      // Check abort BEFORE yielding the next item, never after: the previous
      // item's tool execution has already completed by then, so a stop never
      // leaves a tool_call without its result.
      for await (const item of playbook(ctx, speak, (ms) => this.pause(ms, ctx.signal))) {
        if (ctx.signal.aborted) break
        yield item
      }
      // keep whatever the agent said before being stopped
      const out = parts.join('')
      if (out.trim()) yield { kind: 'message_done', fullText: out }
      // fabricate plausible token usage so the cost UI is exercised without a key
      const inputChars =
        ctx.userMessage.length +
        ctx.transcript.reduce((n, e) => n + e.text.length, 0) +
        ctx.fileTree.join('\n').length +
        400 // system prompt overhead
      yield {
        kind: 'usage',
        inputTokens: Math.max(1, Math.round(inputChars / 4)),
        outputTokens: Math.max(1, Math.round(out.length / 4)),
      }
    } catch (err) {
      if (ctx.signal.aborted) return
      yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  private makeSpeaker(signal: AbortSignal) {
    const fast = this.opts.fast
    return async function* (text: string): AsyncIterable<AgentStreamItem> {
      const tokens = text.split(/(?<=\s)/) // keep whitespace attached
      for (const token of tokens) {
        if (signal.aborted) return
        yield { kind: 'delta', text: token }
        if (!fast) await sleep(10 + Math.random() * 22)
      }
    }
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.opts.fast) return
    await sleep(ms + Math.random() * 150)
  }
}

type Speak = (text: string) => AsyncIterable<AgentStreamItem>
type Pause = (ms: number) => Promise<void>
type Playbook = (ctx: AgentTurnContext, speak: Speak, pause: Pause) => AsyncGenerator<AgentStreamItem>

function pickPlaybook(ctx: AgentTurnContext): Playbook {
  const name = ctx.moduleName.toLowerCase()
  if (/land|home|hero|market|site/.test(name)) return landingPlaybook
  if (/auth|login|sign/.test(name)) return authPlaybook
  if (/edit/.test(name)) return editorPlaybook
  if (/notif|alert|inbox/.test(name)) return notificationsPlaybook
  return genericPlaybook
}

// ---------------------------------------------------------------------------
// Landing page playbook — the flagship demo path
// ---------------------------------------------------------------------------

async function* landingPlaybook(ctx: AgentTurnContext, speak: Speak, pause: Pause): AsyncGenerator<AgentStreamItem> {
  // strip positional phrases ("above the footer") so they don't hijack intent
  const msg = ctx.userMessage
    .toLowerCase()
    .replace(/(above|below|under|over|before|after|into|onto) the (footer|hero|features?|grid|page)/g, '')
  // light keyword steering so demos survive out-of-order asks
  let step: number
  if (!ctx.fileTree.includes('index.html')) step = 0
  else if (/testimonial|quote|pricing|price|plan|faq|question|section/.test(msg)) step = 3
  else if (/feature|grid|highlight/.test(msg)) step = 1
  else if (/footer|copyright/.test(msg)) step = 2
  else step = Math.min(ctx.turnIndex, 3)

  if (step === 0) {
    yield* speak(
      `Let's get ${ctx.projectName} a real landing page. I'll build a hero section with the product name front and center, a one-line pitch underneath, and a waitlist form so visitors can leave their email.\n\nFirst, a quick look at what's already here.\n\n`,
    )
    await pause(350)
    yield { kind: 'tool_call', name: 'list_files', input: {} }
    await ctx.executeTool('list_files', {})
    await pause(250)
    yield* speak(`Clean slate — perfect. I'll create index.html with the hero and the waitlist form.\n\n`)
    await pause(300)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'index.html' } }
    await ctx.executeTool('write_file', { path: 'index.html', content: landingIndexHtml(ctx.projectName) })
    await pause(250)
    yield* speak(`Now the styling — dark, modern, with one strong accent color and plenty of breathing room.\n\n`)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'styles.css' } }
    await ctx.executeTool('write_file', { path: 'styles.css', content: landingCss() })
    await pause(200)
    yield* speak(
      `Done. The page now has a centered hero with the ${ctx.projectName} wordmark, a tagline, and a working waitlist form (it validates the email and confirms inline). Open index.html in a browser to see it. Next natural step: a features section below the hero.`,
    )
    return
  }

  if (step === 1) {
    yield* speak(
      `Good call — a features grid gives the hero something to scroll into. I'll check the current markup so the new section matches its structure.\n\n`,
    )
    await pause(300)
    yield { kind: 'tool_call', name: 'read_file', input: { path: 'index.html' } }
    const read = await ctx.executeTool('read_file', { path: 'index.html' })
    await pause(300)
    if (!read.ok || !read.content) {
      yield* speak(`There's no index.html yet, so I'll create the page with the features section included.\n\n`)
      yield { kind: 'tool_call', name: 'write_file', input: { path: 'index.html' } }
      await ctx.executeTool('write_file', {
        path: 'index.html',
        content: insertSection(landingIndexHtml(ctx.projectName), featuresSectionHtml(ctx.projectName)),
      })
    } else {
      yield* speak(`I'll slot a three-card grid right after the hero: capture, organize, share.\n\n`)
      yield { kind: 'tool_call', name: 'write_file', input: { path: 'index.html' } }
      await ctx.executeTool('write_file', {
        path: 'index.html',
        content: insertSection(read.content, featuresSectionHtml(ctx.projectName)),
      })
    }
    await pause(250)
    yield* speak(`And the styles for the cards — subtle borders, hover lift, responsive columns.\n\n`)
    yield { kind: 'tool_call', name: 'edit_file', input: { path: 'styles.css', old_string: '/* --- sections --- */' } }
    const edit = await ctx.executeTool('edit_file', {
      path: 'styles.css',
      old_string: '/* --- sections --- */',
      new_string: `/* --- sections --- */\n${featuresCss()}`,
    })
    if (!edit.ok) {
      yield* speak(`The stylesheet marker moved, so I'll rewrite styles.css with the grid styles included.\n\n`)
      yield { kind: 'tool_call', name: 'write_file', input: { path: 'styles.css' } }
      await ctx.executeTool('write_file', { path: 'styles.css', content: landingCss() + '\n' + featuresCss() })
    }
    await pause(200)
    yield* speak(
      `The features grid is in: three cards laid out responsively below the hero, each with an icon, a title and a one-liner. It inherits the page's dark palette. A footer would round the page out nicely.`,
    )
    return
  }

  if (step === 2) {
    yield* speak(`A footer will finish the page — links, a small wordmark, and a copyright line.\n\n`)
    await pause(300)
    yield { kind: 'tool_call', name: 'read_file', input: { path: 'index.html' } }
    const read = await ctx.executeTool('read_file', { path: 'index.html' })
    await pause(250)
    const base = read.ok && read.content ? read.content : landingIndexHtml(ctx.projectName)
    yield* speak(`Adding it after the last section, with matching spacing.\n\n`)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'index.html' } }
    await ctx.executeTool('write_file', { path: 'index.html', content: insertFooter(base, ctx.projectName) })
    await pause(200)
    yield { kind: 'tool_call', name: 'edit_file', input: { path: 'styles.css', old_string: '/* --- sections --- */' } }
    const edit = await ctx.executeTool('edit_file', {
      path: 'styles.css',
      old_string: '/* --- sections --- */',
      new_string: `/* --- sections --- */\n${footerCss()}`,
    })
    if (!edit.ok) {
      yield { kind: 'tool_call', name: 'write_file', input: { path: 'footer.css' } }
      await ctx.executeTool('write_file', { path: 'footer.css', content: footerCss() })
    }
    yield* speak(
      `Footer's in place — quick links, the ${ctx.projectName} wordmark, and the copyright. The landing page now reads top to bottom like a real product site.`,
    )
    return
  }

  // step 3+: extend the landing page itself with a themed section
  const theme = /testimonial|quote/.test(msg)
    ? 'testimonials'
    : /pricing|price|plan/.test(msg)
      ? 'pricing'
      : /faq|question/.test(msg)
        ? 'faq'
        : 'highlight'
  yield* speak(
    `I'll add a ${theme} section to the landing page, matching the visual language that's already there.\n\n`,
  )
  await pause(350)
  yield { kind: 'tool_call', name: 'read_file', input: { path: 'index.html' } }
  const read = await ctx.executeTool('read_file', { path: 'index.html' })
  await pause(300)
  const base = read.ok && read.content ? read.content : landingIndexHtml(ctx.projectName)
  const section = landingThemedSection(theme, ctx)
  const withSection = base.includes(`class="${theme}"`)
    ? base
    : base.includes('<footer')
      ? base.replace(/(\s*)<footer/, `\n${section}\n$1<footer`)
      : insertSection(base, section)
  yield* speak(`Slotting the markup in ahead of the footer.\n\n`)
  yield { kind: 'tool_call', name: 'write_file', input: { path: 'index.html' } }
  await ctx.executeTool('write_file', { path: 'index.html', content: withSection })
  await pause(250)
  yield { kind: 'tool_call', name: 'edit_file', input: { path: 'styles.css', old_string: '/* --- sections --- */' } }
  const editRes = await ctx.executeTool('edit_file', {
    path: 'styles.css',
    old_string: '/* --- sections --- */',
    new_string: `/* --- sections --- */\n${landingThemedCss(theme)}`,
  })
  if (!editRes.ok) {
    yield { kind: 'tool_call', name: 'write_file', input: { path: `${theme}.css` } }
    await ctx.executeTool('write_file', { path: `${theme}.css`, content: landingThemedCss(theme) })
  }
  await pause(200)
  yield* speak(
    `Done — the ${theme} section sits above the footer and picks up the page's dark palette. Say the word if you want the copy tightened or another section added.`,
  )
}

// ---------------------------------------------------------------------------
// Auth flow playbook
// ---------------------------------------------------------------------------

async function* authPlaybook(ctx: AgentTurnContext, speak: Speak, pause: Pause): AsyncGenerator<AgentStreamItem> {
  if (ctx.turnIndex === 0 || !ctx.fileTree.includes('auth.html')) {
    yield* speak(
      `Starting the auth flow with a clean sign-in screen: email + password, inline validation, and a link to switch to sign-up. I'll keep it a static mock for now so we can iterate on the feel before wiring a backend.\n\n`,
    )
    await pause(350)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'auth.html' } }
    await ctx.executeTool('write_file', { path: 'auth.html', content: authHtml(ctx.projectName) })
    await pause(250)
    yield* speak(`Styles next — a centered card on a soft gradient, generous input targets.\n\n`)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'auth.css' } }
    await ctx.executeTool('write_file', { path: 'auth.css', content: authCss() })
    await pause(200)
    yield* speak(`The sign-in screen is up: open auth.html to try the validation. Sign-up toggle is the obvious next move.`)
    return
  }
  yield* speak(`I'll add the sign-up mode: a name field that slides in and the submit label swapping over.\n\n`)
  await pause(300)
  yield { kind: 'tool_call', name: 'read_file', input: { path: 'auth.html' } }
  const read = await ctx.executeTool('read_file', { path: 'auth.html' })
  await pause(250)
  yield { kind: 'tool_call', name: 'write_file', input: { path: 'auth.js' } }
  await ctx.executeTool('write_file', { path: 'auth.js', content: authJs() })
  if (read.ok && read.content && !read.content.includes('auth.js')) {
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'auth.html' } }
    await ctx.executeTool('write_file', {
      path: 'auth.html',
      content: read.content.replace('</body>', '  <script src="auth.js"></script>\n</body>'),
    })
  }
  yield* speak(`Done — the card now flips between sign-in and sign-up without a reload.`)
}

// ---------------------------------------------------------------------------
// Editor playbook
// ---------------------------------------------------------------------------

async function* editorPlaybook(ctx: AgentTurnContext, speak: Speak, pause: Pause): AsyncGenerator<AgentStreamItem> {
  if (ctx.turnIndex === 0 || !ctx.fileTree.includes('editor.html')) {
    yield* speak(
      `For the editor I'll start with the writing surface itself: a clean contenteditable page with a floating toolbar for bold, italic and headings. Plain browser APIs, no dependencies.\n\n`,
    )
    await pause(350)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'editor.html' } }
    await ctx.executeTool('write_file', { path: 'editor.html', content: editorHtml(ctx.projectName) })
    await pause(250)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'editor.css' } }
    await ctx.executeTool('write_file', { path: 'editor.css', content: editorCss() })
    await pause(200)
    yield* speak(`The editor shell is ready — open editor.html and start typing. Formatting shortcuts work via the toolbar.`)
    return
  }
  yield* speak(`Adding a live word count and an autosave indicator to the editor footer.\n\n`)
  await pause(300)
  yield { kind: 'tool_call', name: 'read_file', input: { path: 'editor.html' } }
  const read = await ctx.executeTool('read_file', { path: 'editor.html' })
  yield { kind: 'tool_call', name: 'write_file', input: { path: 'editor.js' } }
  await ctx.executeTool('write_file', { path: 'editor.js', content: editorJs() })
  if (read.ok && read.content && !read.content.includes('editor.js')) {
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'editor.html' } }
    await ctx.executeTool('write_file', {
      path: 'editor.html',
      content: read.content.replace('</body>', '  <script src="editor.js"></script>\n</body>'),
    })
  }
  yield* speak(`Done — the footer now shows a live word count and a saved-state dot that pulses on change.`)
}

// ---------------------------------------------------------------------------
// Notifications playbook
// ---------------------------------------------------------------------------

async function* notificationsPlaybook(
  ctx: AgentTurnContext,
  speak: Speak,
  pause: Pause,
): AsyncGenerator<AgentStreamItem> {
  if (ctx.turnIndex === 0 || !ctx.fileTree.includes('notifications.html')) {
    yield* speak(
      `I'll build the notifications surface as a toast system: a stacked corner tray, three severity styles, and a demo page that fires them so we can tune timing and motion.\n\n`,
    )
    await pause(350)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'notifications.html' } }
    await ctx.executeTool('write_file', { path: 'notifications.html', content: notificationsHtml(ctx.projectName) })
    await pause(250)
    yield { kind: 'tool_call', name: 'write_file', input: { path: 'notifications.js' } }
    await ctx.executeTool('write_file', { path: 'notifications.js', content: notificationsJs() })
    await pause(200)
    yield* speak(`Toasts are live — open notifications.html and press the buttons to fire each severity.`)
    return
  }
  yield* genericPlaybook(ctx, speak, pause)
}

// ---------------------------------------------------------------------------
// Generic fallback — sensible behavior for any module/prompt
// ---------------------------------------------------------------------------

async function* genericPlaybook(ctx: AgentTurnContext, speak: Speak, pause: Pause): AsyncGenerator<AgentStreamItem> {
  const slug = slugify(ctx.moduleName)
  const file = `${slug}.html`
  const exists = ctx.fileTree.includes(file)

  yield* speak(
    `Alright — for “${trimTo(ctx.userMessage, 80)}” I'll work in ${file}, keeping the change small and viewable in a browser.\n\n`,
  )
  await pause(350)

  if (!exists) {
    yield { kind: 'tool_call', name: 'write_file', input: { path: file } }
    await ctx.executeTool('write_file', { path: file, content: genericPageHtml(ctx, 1) })
    await pause(250)
    yield* speak(
      `I scaffolded ${file} for the ${ctx.moduleName} module with a first section covering your request (the intent is noted in a comment at the top so the next person has context). Tell me what to build on top of it.`,
    )
    return
  }

  yield { kind: 'tool_call', name: 'read_file', input: { path: file } }
  const read = await ctx.executeTool('read_file', { path: file })
  await pause(300)
  const current = read.ok && read.content ? read.content : genericPageHtml(ctx, 0)
  const sectionCount = (current.match(/<section/g) ?? []).length + 1
  const section = genericSectionHtml(ctx, sectionCount)
  const next = current.includes('</main>')
    ? current.replace('</main>', `${section}\n</main>`)
    : current.replace('</body>', `${section}\n</body>`)
  yield* speak(`Extending the page with a new section for this request.\n\n`)
  yield { kind: 'tool_call', name: 'write_file', input: { path: file } }
  await ctx.executeTool('write_file', { path: file, content: next })
  await pause(200)
  yield* speak(`Added section ${sectionCount} to ${file}, picking up where the page left off.`)
}

// ---------------------------------------------------------------------------
// Content templates
// ---------------------------------------------------------------------------

function landingIndexHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${projectName} — remember everything your team knows</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main>
    <section class="hero">
      <p class="eyebrow">Early access</p>
      <h1>${projectName}</h1>
      <p class="tagline">The team wiki that writes itself — capture decisions where they happen and find them when it matters.</p>
      <form class="waitlist" id="waitlist-form">
        <input type="email" id="waitlist-email" placeholder="you@company.com" aria-label="Email address" required />
        <button type="submit">Join the waitlist</button>
      </form>
      <p class="form-note" id="form-note"></p>
    </section>
    <!-- more sections -->
  </main>
  <script>
    document.getElementById('waitlist-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var email = document.getElementById('waitlist-email').value.trim();
      var note = document.getElementById('form-note');
      if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) {
        note.textContent = 'That email doesn\\'t look right — mind checking it?';
        note.className = 'form-note error';
        return;
      }
      note.textContent = 'You\\'re on the list! We\\'ll be in touch soon.';
      note.className = 'form-note success';
      this.reset();
    });
  </script>
</body>
</html>
`
}

function landingCss(): string {
  return `:root {
  --bg: #0b0b11;
  --surface: #14141d;
  --border: #262636;
  --text: #ecebf5;
  --muted: #9a99b0;
  --accent: #8b7cf6;
}
* { box-sizing: border-box; margin: 0; }
body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background: radial-gradient(1200px 600px at 50% -10%, #1d1a33 0%, var(--bg) 60%);
  color: var(--text);
  min-height: 100vh;
}
main { max-width: 960px; margin: 0 auto; padding: 0 24px; }
.hero { text-align: center; padding: 132px 0 96px; }
.eyebrow {
  display: inline-block; font-size: 13px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--accent); border: 1px solid var(--border); border-radius: 999px; padding: 6px 14px;
}
.hero h1 { font-size: 72px; font-weight: 800; letter-spacing: -0.03em; margin: 24px 0 16px; }
.tagline { font-size: 20px; color: var(--muted); max-width: 560px; margin: 0 auto 40px; line-height: 1.6; }
.waitlist { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.waitlist input {
  background: var(--surface); border: 1px solid var(--border); color: var(--text);
  border-radius: 10px; padding: 14px 16px; font-size: 15px; width: 300px; outline: none;
}
.waitlist input:focus { border-color: var(--accent); }
.waitlist button {
  background: var(--accent); color: #0b0b11; font-weight: 600; font-size: 15px;
  border: none; border-radius: 10px; padding: 14px 22px; cursor: pointer;
}
.waitlist button:hover { filter: brightness(1.1); }
.form-note { margin-top: 14px; font-size: 14px; min-height: 20px; }
.form-note.success { color: #6ee7a8; }
.form-note.error { color: #f38b8b; }
/* --- sections --- */
`
}

function featuresSectionHtml(projectName: string): string {
  return `    <section class="features">
      <h2>Why teams pick ${projectName}</h2>
      <div class="feature-grid">
        <article class="feature-card">
          <div class="feature-icon">⚡</div>
          <h3>Capture instantly</h3>
          <p>Drop notes, decisions and links the moment they happen — no ceremony, no templates.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">🧭</div>
          <h3>Organized for you</h3>
          <p>Pages file themselves by team and topic, so the wiki stays navigable without a librarian.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">🔍</div>
          <h3>Found in seconds</h3>
          <p>Search that understands what you meant — surface the decision, not just the document.</p>
        </article>
      </div>
    </section>`
}

function featuresCss(): string {
  return `.features { padding: 40px 0 96px; text-align: center; }
.features h2 { font-size: 32px; letter-spacing: -0.02em; margin-bottom: 40px; }
.feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; }
.feature-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 16px;
  padding: 28px 24px; text-align: left; transition: transform 0.18s ease, border-color 0.18s ease;
}
.feature-card:hover { transform: translateY(-3px); border-color: var(--accent); }
.feature-icon { font-size: 26px; margin-bottom: 14px; }
.feature-card h3 { font-size: 18px; margin-bottom: 8px; }
.feature-card p { color: var(--muted); font-size: 15px; line-height: 1.6; }
`
}

function landingThemedSection(theme: string, ctx: AgentTurnContext): string {
  if (theme === 'testimonials') {
    return `    <section class="testimonials">
      <h2>Teams already remember more</h2>
      <div class="quote-grid">
        <blockquote class="quote-card">
          <p>“We stopped asking ‘where did we write that down?’ in week one.”</p>
          <footer>— Maya, engineering lead</footer>
        </blockquote>
        <blockquote class="quote-card">
          <p>“The first wiki our team actually keeps up to date.”</p>
          <footer>— Jonas, founder</footer>
        </blockquote>
      </div>
    </section>`
  }
  if (theme === 'pricing') {
    return `    <section class="pricing">
      <h2>Simple pricing</h2>
      <div class="tier-grid">
        <div class="tier-card"><h3>Free</h3><p class="tier-price">$0</p><p>Up to 5 teammates</p></div>
        <div class="tier-card featured"><h3>Team</h3><p class="tier-price">$8<span>/user</span></p><p>Unlimited pages & search</p></div>
        <div class="tier-card"><h3>Scale</h3><p class="tier-price">Let's talk</p><p>SSO, audit log, support</p></div>
      </div>
    </section>`
  }
  if (theme === 'faq') {
    return `    <section class="faq">
      <h2>Questions, answered</h2>
      <details><summary>How is this different from a normal wiki?</summary><p>Pages organize themselves and search understands intent — no librarian required.</p></details>
      <details><summary>Can we import our existing docs?</summary><p>Yes — Markdown, Notion and Confluence import are on the roadmap.</p></details>
      <details><summary>Is our data private?</summary><p>Your workspace is isolated and encrypted at rest.</p></details>
    </section>`
  }
  return `    <section class="highlight">
      <h2>${escapeHtml(trimTo(ctx.userMessage, 60))}</h2>
      <p>${escapeHtml(trimTo(ctx.userMessage, 160))}</p>
    </section>`
}

function landingThemedCss(theme: string): string {
  if (theme === 'testimonials') {
    return `.testimonials { padding: 24px 0 96px; text-align: center; }
.testimonials h2 { font-size: 32px; letter-spacing: -0.02em; margin-bottom: 36px; }
.quote-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
.quote-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 28px; text-align: left; margin: 0; }
.quote-card p { font-size: 17px; line-height: 1.6; }
.quote-card footer { margin-top: 14px; color: var(--muted); font-size: 14px; }
`
  }
  if (theme === 'pricing') {
    return `.pricing { padding: 24px 0 96px; text-align: center; }
.pricing h2 { font-size: 32px; letter-spacing: -0.02em; margin-bottom: 36px; }
.tier-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }
.tier-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 28px 24px; }
.tier-card.featured { border-color: var(--accent); }
.tier-price { font-size: 34px; font-weight: 800; margin: 10px 0; }
.tier-price span { font-size: 14px; color: var(--muted); font-weight: 400; }
.tier-card p { color: var(--muted); font-size: 14px; }
`
  }
  if (theme === 'faq') {
    return `.faq { padding: 24px 0 96px; max-width: 640px; margin: 0 auto; }
.faq h2 { font-size: 32px; letter-spacing: -0.02em; margin-bottom: 28px; text-align: center; }
.faq details { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 10px; }
.faq summary { cursor: pointer; font-weight: 600; }
.faq details p { margin-top: 10px; color: var(--muted); line-height: 1.6; }
`
  }
  return `.highlight { padding: 24px 0 96px; text-align: center; }
.highlight h2 { font-size: 28px; margin-bottom: 12px; }
.highlight p { color: var(--muted); max-width: 560px; margin: 0 auto; line-height: 1.6; }
`
}

function insertSection(html: string, section: string): string {
  if (html.includes('<!-- more sections -->')) {
    return html.replace('<!-- more sections -->', `${section}\n    <!-- more sections -->`)
  }
  if (html.includes('</main>')) return html.replace('</main>', `${section}\n  </main>`)
  return html.replace('</body>', `${section}\n</body>`)
}

function insertFooter(html: string, projectName: string): string {
  const footer = `  <footer class="site-footer">
    <div class="footer-inner">
      <span class="footer-brand">${projectName}</span>
      <nav class="footer-links">
        <a href="#">Product</a>
        <a href="#">Changelog</a>
        <a href="#">Privacy</a>
        <a href="#">Contact</a>
      </nav>
      <span class="footer-copy">© ${new Date().getFullYear()} ${projectName}. All rights reserved.</span>
    </div>
  </footer>`
  if (html.includes('class="site-footer"')) return html
  return html.replace('</body>', `${footer}\n</body>`)
}

function footerCss(): string {
  return `.site-footer { border-top: 1px solid var(--border); margin-top: 40px; }
.footer-inner {
  max-width: 960px; margin: 0 auto; padding: 32px 24px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
}
.footer-brand { font-weight: 700; letter-spacing: -0.01em; }
.footer-links { display: flex; gap: 20px; }
.footer-links a { color: var(--muted); text-decoration: none; font-size: 14px; }
.footer-links a:hover { color: var(--text); }
.footer-copy { color: var(--muted); font-size: 13px; }
`
}

function authHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in — ${projectName}</title>
  <link rel="stylesheet" href="auth.css" />
</head>
<body>
  <main class="auth-wrap">
    <form class="auth-card" id="auth-form">
      <h1 id="auth-title">Welcome back</h1>
      <p class="auth-sub" id="auth-sub">Sign in to your ${projectName} workspace</p>
      <label class="field name-field" id="name-field" hidden>
        <span>Name</span>
        <input type="text" id="name" placeholder="Ada Lovelace" />
      </label>
      <label class="field">
        <span>Email</span>
        <input type="email" id="email" placeholder="you@company.com" required />
      </label>
      <label class="field">
        <span>Password</span>
        <input type="password" id="password" placeholder="••••••••" required minlength="8" />
      </label>
      <button type="submit" id="auth-submit">Sign in</button>
      <p class="auth-note" id="auth-note"></p>
      <p class="auth-switch">
        <span id="switch-label">New to ${projectName}?</span>
        <a href="#" id="switch-link">Create an account</a>
      </p>
    </form>
  </main>
</body>
</html>
`
}

function authCss(): string {
  return `* { box-sizing: border-box; margin: 0; }
body {
  font-family: 'Inter', system-ui, sans-serif;
  background: linear-gradient(160deg, #101019 0%, #1a1530 100%);
  color: #ecebf5; min-height: 100vh; display: grid; place-items: center;
}
.auth-wrap { width: 100%; max-width: 400px; padding: 24px; }
.auth-card {
  background: #14141d; border: 1px solid #262636; border-radius: 18px; padding: 36px 32px;
  display: flex; flex-direction: column; gap: 16px;
}
.auth-card h1 { font-size: 24px; letter-spacing: -0.02em; }
.auth-sub { color: #9a99b0; font-size: 14px; margin-top: -8px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #9a99b0; }
.field input {
  background: #0e0e15; border: 1px solid #262636; border-radius: 10px; color: #ecebf5;
  padding: 12px 14px; font-size: 15px; outline: none;
}
.field input:focus { border-color: #8b7cf6; }
button[type="submit"] {
  background: #8b7cf6; color: #0b0b11; font-weight: 600; font-size: 15px;
  border: none; border-radius: 10px; padding: 13px; cursor: pointer; margin-top: 4px;
}
button[type="submit"]:hover { filter: brightness(1.08); }
.auth-note { font-size: 13px; min-height: 18px; }
.auth-note.error { color: #f38b8b; }
.auth-note.success { color: #6ee7a8; }
.auth-switch { font-size: 13px; color: #9a99b0; text-align: center; }
.auth-switch a { color: #8b7cf6; text-decoration: none; margin-left: 4px; }
`
}

function authJs(): string {
  return `// Toggles the auth card between sign-in and sign-up modes.
var signup = false;
var form = document.getElementById('auth-form');
var note = document.getElementById('auth-note');

document.getElementById('switch-link').addEventListener('click', function (e) {
  e.preventDefault();
  signup = !signup;
  document.getElementById('auth-title').textContent = signup ? 'Create your account' : 'Welcome back';
  document.getElementById('auth-sub').textContent = signup ? 'A minute from now you have a wiki' : 'Sign in to your workspace';
  document.getElementById('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
  document.getElementById('switch-label').textContent = signup ? 'Already have an account?' : 'New here?';
  this.textContent = signup ? 'Sign in instead' : 'Create an account';
  document.getElementById('name-field').hidden = !signup;
  note.textContent = '';
});

form.addEventListener('submit', function (e) {
  e.preventDefault();
  var email = document.getElementById('email').value.trim();
  var password = document.getElementById('password').value;
  if (password.length < 8) {
    note.textContent = 'Passwords need at least 8 characters.';
    note.className = 'auth-note error';
    return;
  }
  note.textContent = signup ? 'Account created (mock) — welcome aboard!' : 'Signed in (mock) — redirecting…';
  note.className = 'auth-note success';
});
`
}

function editorHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Editor — ${projectName}</title>
  <link rel="stylesheet" href="editor.css" />
</head>
<body>
  <main class="editor-shell">
    <header class="editor-toolbar">
      <button data-cmd="bold" title="Bold"><b>B</b></button>
      <button data-cmd="italic" title="Italic"><i>I</i></button>
      <button data-cmd="formatBlock" data-value="h2" title="Heading">H</button>
      <button data-cmd="insertUnorderedList" title="Bullet list">••</button>
    </header>
    <article class="editor-page" id="page" contenteditable="true">
      <h1>Untitled page</h1>
      <p>Start writing — select text to format it with the toolbar above.</p>
    </article>
    <footer class="editor-footer" id="editor-footer"></footer>
  </main>
  <script>
    document.querySelectorAll('.editor-toolbar button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.execCommand(btn.dataset.cmd, false, btn.dataset.value || null);
        document.getElementById('page').focus();
      });
    });
  </script>
</body>
</html>
`
}

function editorCss(): string {
  return `* { box-sizing: border-box; margin: 0; }
body { font-family: 'Inter', system-ui, sans-serif; background: #101016; color: #ecebf5; }
.editor-shell { max-width: 760px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; }
.editor-toolbar {
  position: sticky; top: 16px; align-self: center; display: flex; gap: 4px;
  background: #191925; border: 1px solid #2a2a3a; border-radius: 12px; padding: 6px; margin: 16px 0;
}
.editor-toolbar button {
  background: transparent; border: none; color: #cfcfe2; width: 34px; height: 30px;
  border-radius: 8px; cursor: pointer; font-size: 14px;
}
.editor-toolbar button:hover { background: #262636; }
.editor-page { flex: 1; outline: none; padding: 24px 16px 96px; line-height: 1.7; }
.editor-page h1 { font-size: 36px; letter-spacing: -0.02em; margin-bottom: 16px; }
.editor-page h2 { margin: 20px 0 8px; }
.editor-page p { color: #c6c5d8; margin-bottom: 12px; }
.editor-footer { padding: 12px 16px; color: #77768c; font-size: 13px; border-top: 1px solid #1e1e2b; }
`
}

function editorJs(): string {
  return `// Live word count + autosave indicator for the editor footer.
var page = document.getElementById('page');
var footer = document.getElementById('editor-footer');
var timer = null;

function update() {
  var words = (page.innerText.trim().match(/\\S+/g) || []).length;
  footer.innerHTML = words + ' words · <span id="save-state">saving…</span>';
  clearTimeout(timer);
  timer = setTimeout(function () {
    var state = document.getElementById('save-state');
    if (state) state.textContent = 'saved';
  }, 600);
}

page.addEventListener('input', update);
update();
`
}

function notificationsHtml(projectName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Notifications — ${projectName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #101016; color: #ecebf5; min-height: 100vh; display: grid; place-items: center; }
    .demo { text-align: center; display: flex; gap: 10px; }
    .demo button { background: #191925; color: #ecebf5; border: 1px solid #2a2a3a; border-radius: 10px; padding: 12px 18px; cursor: pointer; }
    .demo button:hover { border-color: #8b7cf6; }
    #toast-tray { position: fixed; bottom: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; }
    .toast { background: #191925; border: 1px solid #2a2a3a; border-left: 3px solid var(--edge, #8b7cf6); border-radius: 10px; padding: 12px 16px; min-width: 260px; text-align: left; animation: slide-in 0.25s ease; font-size: 14px; }
    .toast.leaving { opacity: 0; transform: translateX(12px); transition: all 0.3s ease; }
    @keyframes slide-in { from { opacity: 0; transform: translateX(16px); } }
  </style>
</head>
<body>
  <div class="demo">
    <button onclick="toast('Page published to the team wiki', 'success')">Success</button>
    <button onclick="toast('Two teammates are editing this page', 'info')">Info</button>
    <button onclick="toast('Sync failed — retrying in 5s', 'error')">Error</button>
  </div>
  <div id="toast-tray"></div>
  <script src="notifications.js"></script>
</body>
</html>
`
}

function notificationsJs(): string {
  return `// Minimal toast system: three severities, auto-dismiss, stacking tray.
var EDGE = { success: '#6ee7a8', info: '#8b7cf6', error: '#f38b8b' };

function toast(message, kind) {
  var tray = document.getElementById('toast-tray');
  var el = document.createElement('div');
  el.className = 'toast';
  el.style.setProperty('--edge', EDGE[kind] || EDGE.info);
  el.textContent = message;
  tray.appendChild(el);
  setTimeout(function () {
    el.classList.add('leaving');
    setTimeout(function () { el.remove(); }, 320);
  }, 3200);
}
`
}

function genericPageHtml(ctx: AgentTurnContext, sectionNumber: number): string {
  return `<!doctype html>
<!--
  Module: ${ctx.moduleName}
  Requested by ${ctx.driverName}: ${ctx.userMessage.replace(/-->/g, '')}
-->
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${ctx.moduleName} — ${ctx.projectName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #101016; color: #ecebf5; }
    main { max-width: 720px; margin: 0 auto; padding: 64px 24px; }
    h1 { letter-spacing: -0.02em; margin-bottom: 8px; }
    .lede { color: #9a99b0; margin-bottom: 40px; }
    section { border: 1px solid #262636; background: #14141d; border-radius: 14px; padding: 24px; margin-bottom: 16px; }
    section h2 { font-size: 18px; margin-bottom: 8px; }
    section p { color: #c6c5d8; line-height: 1.6; }
  </style>
</head>
<body>
  <main>
    <h1>${ctx.moduleName}</h1>
    <p class="lede">Part of ${ctx.projectName}. Built iteratively in a Loom session.</p>
${genericSectionHtml(ctx, sectionNumber)}
  </main>
</body>
</html>
`
}

function genericSectionHtml(ctx: AgentTurnContext, n: number): string {
  return `    <!-- ${ctx.driverName} asked: ${ctx.userMessage.replace(/-->/g, '')} -->
    <section>
      <h2>Iteration ${n}</h2>
      <p>${escapeHtml(trimTo(ctx.userMessage, 180))}</p>
    </section>`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function trimTo(s: string, n: number): string {
  const clean = s.trim().replace(/\s+/g, ' ')
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
