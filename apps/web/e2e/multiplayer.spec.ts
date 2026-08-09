import { expect, test } from '@playwright/test'

/**
 * The product's soul as an executable test: two real browsers, one repo.
 * Ayan drives a session; Sai watches it live, forks it, keeps building, and
 * merges into main — all in mock mode with no API key.
 */
test('two users: Ayan drives, Sai watches → forks → continues → merges', async ({ browser }) => {
  const ayanCtx = await browser.newContext()
  const saiCtx = await browser.newContext()
  const ayan = await ayanCtx.newPage()
  const sai = await saiCtx.newPage()

  // ---------------------------------------------------------------- Ayan drives
  await ayan.goto('/')
  await ayan.getByTestId('quick-login-ayan@loom.dev').click()

  // home → Nimbus → Landing page module → start a session
  await ayan.getByRole('link', { name: /Nimbus/ }).click()
  await ayan.getByTestId('module-card-Landing page').click()
  await ayan.getByRole('button', { name: /Start session/ }).click()
  await expect(ayan.getByPlaceholder(/Tell the agent what to build/)).toBeVisible()

  // drive a turn
  await ayan.getByPlaceholder(/Tell the agent what to build/).fill('Build a hero section with our name and a waitlist form')
  await ayan.getByRole('button', { name: 'Send', exact: true }).click()

  // the turn lands a commit — its plain-English explanation appears in the log
  await expect(ayan.getByText(/Ayan asked the agent to/i)).toBeVisible({ timeout: 40_000 })
  const sessionUrl = ayan.url()
  expect(sessionUrl).toMatch(/\/s\//)

  // ------------------------------------------------------- Sai watches & forks
  await sai.goto('/')
  await sai.getByTestId('quick-login-sai@loom.dev').click()
  await expect(sai.getByRole('link', { name: /Nimbus/ })).toBeVisible()

  // open Ayan's session directly (spectate)
  await sai.goto(sessionUrl)
  // Sai sees Ayan's committed work stream in
  await expect(sai.getByText(/Ayan asked the agent to/i)).toBeVisible({ timeout: 20_000 })
  await expect(sai.getByText(/hero section/i).first()).toBeVisible()

  // Sai is a spectator (not the driver) → the fork affordance is offered
  const forkButton = sai.getByRole('button', { name: /Fork & continue from here/ })
  await expect(forkButton).toBeVisible()
  await forkButton.click()

  // now on Sai's own fork — a driver, with Ayan's transcript carried over
  await expect(sai).toHaveURL(/\/s\//)
  await expect(sai.getByText(/hero section/i).first()).toBeVisible()
  await expect(sai.getByPlaceholder(/Tell the agent what to build/)).toBeVisible({ timeout: 20_000 })
  expect(sai.url()).not.toBe(sessionUrl) // a different session

  // Sai keeps building on the fork
  await sai.getByPlaceholder(/Tell the agent what to build/).fill('Now add a features grid below the hero')
  await sai.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(sai.getByText(/Sai asked the agent to/i)).toBeVisible({ timeout: 40_000 })

  // ------------------------------------------------------------------- Sai merges
  const projectHistory = sessionUrl.replace(/\/s\/[^/]+.*$/, '/history')
  await sai.goto(projectHistory)
  await expect(sai.getByRole('heading', { name: /Version history/ })).toBeVisible()

  // both session branches are ahead of main; merge the first one
  const mergeButton = sai.getByRole('button', { name: /Merge into main/ }).first()
  await expect(mergeButton).toBeVisible({ timeout: 20_000 })
  await mergeButton.click()

  // the merge lands cleanly and is announced in the timeline / note
  await expect(
    sai.getByText(/Merged cleanly into main|part of the main version/i).first(),
  ).toBeVisible({ timeout: 20_000 })

  await ayanCtx.close()
  await saiCtx.close()
})
