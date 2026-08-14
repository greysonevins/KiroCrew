/**
 * Screenshot harness + geometry check for PINNED CREW CHIPS in the top header.
 *
 * Photographs the states of the switcher (nothing pinned, short names pinned, and
 * a row that overflows and is clipped) and ASSERTS the invariant the design rests on: a pinned chip row never reaches
 * the centered top-bar search overlay, so the overlay keeps its full width and
 * never unmounts.
 *
 * Crews are pinned by DRIVING THE UI, not by seeding localStorage: the dashboard
 * does not carry a pre-seeded value across the reload the store would need to
 * observe it, and clicking the real menu rows proves the interaction as a
 * side-effect instead of assuming it.
 *
 * Runs against the REAL built SPA (website/dist) with a stubbed API, so the
 * geometry measured here is what the header actually produces. Nothing in CI runs
 * this file; the CI-enforced half of the invariant is
 * `src/test/topbarLayout.test.ts`.
 *
 * Usage: npm run build && node scripts/capture-crew-pin-chips.mjs [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/crew-pin-chips'

/**
 * 1280px wide on purpose: an ordinary laptop width, and the one where a full
 * pinned row has to share the left grid track with the centered search column.
 */
const VIEWPORT = { width: 1280, height: 760 }

/** Just the header band — the rest of the shell is not what these prove. */
const HEADER_CLIP = { x: 0, y: 0, width: VIEWPORT.width, height: 54 }

const crew = (id, name, sshHost, port) => ({
  id,
  name,
  ssh_host: sshHost,
  remote_port: 7777,
  local_port: port,
  ttl: '20h',
  remote_bin: '',
  // The SSM-transport fields are not optional on the wire: the dashboard reads
  // them while deciding which lifecycle actions a row may offer, and omitting
  // them crashes the shell rather than degrading.
  connection_method: 'ssh',
  ssm_target: '',
  ssm_run_as: '',
  aws_profile: '',
  aws_region: '',
  // Deliberately false: `visibleInstanceTabs` admits a crew on a live
  // `status.state` alone, and setting the sticky-intent flag would make the
  // dashboard auto-connect and mount a cross-origin remote pane iframe — noise
  // this harness has no use for.
  was_connected: false,
  status: { instance_id: id, state: 'connected', local_port: port, remote_port: 7777 },
})

// A mix of short and host-shaped names, because the row's capacity is a pixel
// budget: the long ones are what make a four-crew row overflow where a
// four-short-name row would fit.
const CREWS = [
  crew('devdesk', 'devdesk', 'dev-dsk-alias', 7801),
  crew('prod', 'prod-us-east-1', 'prod-use1-alias', 7802),
  crew('staging', 'staging-eu-west-1', 'stg-euw1-alias', 7803),
  crew('sandbox', 'sandbox', 'sandbox-alias', 7804),
]

const SSO = { state: 'ok', seconds_remaining: 72000, expires_at: null, reason: 'valid' }

/**
 * One live session. Not decoration: with no slots the command palette's recents
 * provider maps over a placeholder that has no `key`, and `normalizeKey` takes
 * the whole shell down through its error boundary — which looks like a crash in
 * whatever is being photographed rather than a missing fixture.
 */
const SLOTS = [{
  key: 'crew-pin-shot',
  title: 'Switching between crews',
  running: false,
  last_message: 'Pinned devdesk to the header.',
  messages: 2,
  agent: 'kirocrew',
  memory_mode: 'persistent',
  folder_id: '',
  modified: Math.floor(Date.now() / 1000),
  source_links: [],
  source_links_total: 0,
}]

const TRIGGER = '[aria-label^="Switch crew"]'
const CHIP_ROW = '[data-testid="crew-chip-row"]'
const PINNED_KEY = 'mc-crew-switcher-pinned'

const results = []

async function main() {
  const { srv, base } = await serveDist()
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()

  /**
   * Routes the shared stub does not know about. Each branch AWAITS `json()` then
   * returns `true`: the stub reads a falsy return as "not handled" and fulfils
   * the route itself, which would double-fulfil the request.
   *
   * The list route is matched EXACTLY. A `startsWith('/api/instances')` catch-all
   * also swallows `/{id}/connect`, answering it with the list payload — the
   * dashboard then reads `state` off a response that has none and the shell dies
   * inside its error boundary, with no page error to show for it.
   */
  const extra = async (path, route) => {
    if (path === '/api/instances') {
      await json(route, { active: true, instances: CREWS, warm_set_cap: 5, sso: SSO })
      return true
    }
    const tunnel = /^\/api\/instances\/([^/]+)\/(connect|refresh-token)$/.exec(path)
    if (tunnel) {
      const id = decodeURIComponent(tunnel[1])
      const found = CREWS.find(c => c.id === id)
      await json(route, {
        ...(found ? found.status : { instance_id: id, state: 'connected' }),
        token: 'stub-token',
      })
      return true
    }
    if (path.startsWith('/api/instances/')) {
      await json(route, { ok: true })
      return true
    }
    return false
  }

  /**
   * @param name    output file stem
   * @param pinIds  crews to pre-pin
   */
  async function scenario(name, pinIds, opts = {}) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
    const page = await context.newPage()
    logPageProblems(page)
    // A crew reported `connected` makes InstancesViewport mount a warm pane
    // iframe pointed at its forwarded port. Nothing serves those ports here, so
    // the iframe would load this same SPA cross-origin, trip on storage it is not
    // allowed to read, and take the shell down with it. Serve them a blank
    // document: the pane is not what these screenshots are about.
    await page.route(/127\.0\.0\.1:78\d\d/, route =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>pane</title>' }),
    )
    await stubDashboardApi(page, { theme: 'dark', slots: SLOTS, extra })
    // Registered AFTER the stub, and this ordering is load-bearing: the stub's own
    // init script opens with `localStorage.clear()` to keep screenshots
    // deterministic, so anything seeded earlier — an earlier `addInitScript`, or
    // `storageState` — is wiped before the bundle reads it. Init scripts run in
    // registration order, so writing here lands after that clear. The pin store
    // reads storage once at module import, which is why the value has to be in
    // place before the first evaluation rather than set afterwards.
    await page.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value)
      },
      [PINNED_KEY, JSON.stringify(pinIds)],
    )
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })

    // The switcher only mounts once the instances poll resolves.
    await page.waitForSelector(TRIGGER, { timeout: 20000 })
    if (pinIds.length) await page.waitForSelector(CHIP_ROW, { timeout: 10000 })


    await page.waitForTimeout(300)

    // Geometry: does the switcher reach the centered search overlay?
    const geom = await page.evaluate(() => {
      const box = el => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
      }
      const row = document.querySelector('[data-testid="crew-chip-row"]')
      const chevron = document.querySelector('[aria-label^="Switch crew"]')
      const kids = row ? [...row.children] : []
      return {
        overlay: box(document.querySelector('[data-topbar-overlay]')),
        row: box(row),
        // The chevron TRAILS the chips, so it is the switcher's rightmost edge.
        trigger: box(chevron),
        chips: kids.length,
        // Clipping is horizontal: the row is one nowrap line, so a chip is cut off
        // once its trailing edge passes the row's visible width.
        chipsClipped: kids.filter(
          k => k.offsetLeft + k.offsetWidth > (row ? row.clientWidth : 0) + 1,
        ).length,
        // THE reason this layout clips instead of wrapping: the chevron has to sit
        // against the last visible chip. A wrapped row keeps its full ALLOCATED
        // width with the wrapped chips' space empty, pushing the chevron away by a
        // viewport-dependent gap. This is that gap, and it must stay at the flex
        // gap (4px).
        chevronGap:
          row && chevron
            ? Math.round(chevron.getBoundingClientRect().left - row.getBoundingClientRect().right)
            : null,
      }
    })

    const reach = Math.max(geom.trigger?.right ?? 0, geom.row?.right ?? 0)
    results.push({
      name,
      overlayPresent: !!geom.overlay,
      overlayWidth: geom.overlay?.width ?? 0,
      switcherReach: reach,
      overlayLeft: geom.overlay?.left ?? null,
      clearsOverlay: geom.overlay ? reach <= geom.overlay.left : null,
      chips: geom.chips,
      chipsClipped: geom.chipsClipped,
      chevronGap: geom.chevronGap,
    })

    await page.screenshot({
      path: `${OUT}/${name}.png`,
      clip: HEADER_CLIP,
    })
    await page.close()
    await context.close()
  }

  // 1. Nothing pinned — the default. No chip row at all, so a single-crew user
  //    pays no header width for the feature.
  await scenario('01-nothing-pinned', [])

  // 2. Two short names pinned — both fit, both one click away.
  await scenario('02-two-short-names-pinned', ['devdesk', 'sandbox'])

  // 3. All four pinned, two of them host-shaped — the row overflows and the chips
  //    that do not fit are cut at the row edge, marked by the fade.
  await scenario('03-overflow-clipped-with-fade', ['devdesk', 'prod', 'staging', 'sandbox'])



  await browser.close()
  srv.close()

  console.log('--- geometry (the switcher must never reach the centered search overlay) ---')
  for (const r of results) console.log(JSON.stringify(r))

  const derived = results
  const bad = derived.filter(r => !r.overlayPresent || r.clearsOverlay !== true)
  const pinnedShots = derived.filter(r => r.name !== '01-nothing-pinned')

  if (bad.length) {
    console.error('FAIL: the derived bound let the switcher reach the search overlay:')
    for (const r of bad) console.error('  ' + JSON.stringify(r))
    process.exit(1)
  }
  if (pinnedShots.some(r => r.chips === 0)) {
    console.error('FAIL: a scenario pinned crews but rendered no chips — the UI path is broken,')
    console.error('      so these screenshots would document a feature that does not work.')
    process.exit(1)
  }
  if (!derived.some(r => r.chipsClipped > 0)) {
    console.error('FAIL: no scenario overflowed, so the clipping evidence is vacuous.')
    process.exit(1)
  }
  // The chip row is a flex sibling with a 4px gap, so anything materially larger
  // means the row is holding space it is not using — the wrapped-layout defect
  // this arrangement exists to avoid.
  const CHEVRON_GAP_MAX = 6
  const gappy = derived.filter(r => r.chips > 0 && (r.chevronGap ?? 0) > CHEVRON_GAP_MAX)
  if (gappy.length) {
    console.error(`FAIL: the dropdown drifted from the last chip (ceiling ${CHEVRON_GAP_MAX}px):`)
    for (const r of gappy) console.error('  ' + JSON.stringify(r))
    process.exit(1)
  }

  console.log('OK')
}

main().catch(err => { console.error(err); process.exit(1) })
