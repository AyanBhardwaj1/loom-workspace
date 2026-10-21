import { expect, test } from '@playwright/test'

/**
 * C9 — feature specs beyond the core demo flow:
 *  - F2 replay: scrub a driven session from the read-only player
 *  - F3 fork-from-event: the hover affordance + confirm popover cuts an
 *    earlier copy whose log stops at that event
 */

test('replay: a driven session scrubs from zero to full', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('quick-login-ayan@loom.dev').click()
  await page.getByRole('link', { name: /Nimbus/ }).click()
  await page.getByTestId('module-card-Landing page').click()
  await page.getByRole('button', { name: /Start session/ }).click()
  await page.getByPlaceholder(/Tell the agent what to build/).fill('Build a hero section with a waitlist form')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(/Ayan asked the agent to/i)).toBeVisible({ timeout: 40_000 })

  // open the replay
  await page.getByRole('link', { name: /Replay/ }).click()
  await expect(page).toHaveURL(/\/replay\//)
  await expect(page.getByText('Replay', { exact: true })).toBeVisible()

  // it opens at the end (N / N), scrubs to zero, then plays forward
  const range = page.locator('.replay-range')
  await expect(range).toBeVisible()
  const total = Number(await range.getAttribute('max'))
  expect(total).toBeGreaterThan(3)
  await range.fill('0')
  await expect(page.getByText(`0 / ${total}`)).toBeVisible()
  await range.fill(String(Math.floor(total / 2)))
  await expect(page.getByText(`${Math.floor(total / 2)} / ${total}`)).toBeVisible()
  await range.fill(String(total))
  // the commit explanation is visible again at full reveal
  await expect(page.getByText(/Ayan asked the agent to/i)).toBeVisible()
})

test('fork-from-event: the confirm popover cuts a copy at that point', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('quick-login-sai@loom.dev').click()
  await page.getByRole('link', { name: /Nimbus/ }).click()
  await page.getByTestId('module-card-Auth flow').click()
  await page.getByRole('button', { name: /Start session/ }).click()
  await page.getByPlaceholder(/Tell the agent what to build/).fill('Build a sign-in form')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(/Sai asked the agent to/i)).toBeVisible({ timeout: 40_000 })
  const sourceUrl = page.url()

  // hover the FIRST user message row → ghost fork icon → confirm popover
  const firstRow = page.locator('[data-event-row]').first()
  await firstRow.hover()
  await firstRow.getByTitle('Fork from this point').click()
  await expect(page.getByText(/you[’']ll get the conversation and code exactly as of this event/i)).toBeVisible()
  await page.getByRole('button', { name: 'Fork', exact: true }).click()

  // a different session, whose log is the truncated prefix (no commit yet)
  await expect(page).toHaveURL(/\/s\//, { timeout: 20_000 })
  await expect
    .poll(async () => page.url(), { timeout: 20_000 })
    .not.toBe(sourceUrl)
  await expect(page.getByPlaceholder(/Tell the agent what to build/)).toBeVisible({ timeout: 20_000 })
  // the fork's MAIN log stops before the commit explanation (the spectate
  // panel may still echo the live source session — scope to the main log)
  await expect(page.getByTestId('main-log').getByText(/It (created|updated)/i)).toHaveCount(0)
})
