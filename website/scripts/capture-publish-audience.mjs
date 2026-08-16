/**
 * Screenshot harness for the Publish panel's audience + success-shape fix.
 *
 * Runs the real built SPA behind the shared gateway-free fixture server and
 * drives the artifact detail page's Publish panel for BOTH audiences.
 *
 * Frames:
 *   01-internal-confirm     internal destination: no public-exposure warning
 *   02-internal-published   the artifact-shaped response renders as Published
 *   03-public-confirm       public destination: warning still present
 *   04-public-ack           public destination: acknowledgment still blocking
 *
 * Run it twice to produce before/after evidence — once on this branch and once
 * with the component reverted (`before` prefix). On `before`, frame 02 shows the
 * defect: a bare red icon with no message, on a publish that succeeded.
 *
 * Usage: node scripts/capture-publish-audience.mjs [outDir] [prefix]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from './lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from './lib/stub-dashboard-api.mjs'

const OUT = process.argv[2] || '../temp-screenshots/publish-hub-internal-audience'
const PREFIX = process.argv[3] || 'after'

mkdirSync(OUT, { recursive: true })

const ARTIFACT = {
  slug: 'interactive-data-visualization',
  name: 'Interactive Data Visualization',
  kind: 'widget',
  source: 'chat',
  description: 'Interactive multi-chart dashboard with filterable bar, line and scatter charts',
  tags: ['visualization', 'charts'],
  version: 1,
  pinned: false,
  created_at: '2026-08-11T02:18:25.000000+00:00',
  updated_at: '2026-08-11T02:18:25.000000+00:00',
}

const RAW_HTML = '<main style="padding:32px"><h1>Engineering Metrics Dashboard</h1></main>'

const INTERNAL_PROVIDER = {
  id: 'artifactory',
  label: 'Artifactory (internal)',
  icon: 'Upload',
  endpoint: '/api/apps/internal-publish/publish',
  kinds: ['widget', 'html', 'markdown'],
  setupRoute: '/internal-publish',
  audience: 'internal',
  app: 'internal-publish',
  origin: 'app',
  configured: true,
}

const PUBLIC_PROVIDER = {
  id: 'deploy-web-aws',
  label: 'Publish to public web (your AWS)',
  icon: 'Globe',
  endpoint: '/api/deploy/deploy',
  kinds: ['widget', 'html', 'markdown'],
  setupRoute: '/artifacts/deploy',
  audience: 'public',
  app: '',
  origin: 'core',
  configured: true,
}

/** The serialized artifact `POST /api/artifacts/{slug}/publish` answers with. */
const PUBLISHED_ARTIFACT = {
  ...ARTIFACT,
  publication: {
    provider: 'artifactory',
    visibility: 'PRIVATE',
    published_by: 'owner',
    view_url: 'https://artifactory.internal.example.com/view/3c195b2d',
  },
}

/**
 * Preview copy per destination. The public row must NOT reuse the internal row's
 * "as PRIVATE" message: that puts the word PRIVATE directly above the
 * public-internet warning, which reads as contradictory evidence.
 */
const PREVIEW_MESSAGE = {
  artifactory:
    'Publishes this artifact to Artifactory as PRIVATE. Change visibility, add ' +
    'shared-with aliases, or unpublish afterwards from the Publishing page.',
  'deploy-web-aws': 'Deploys this artifact to a public CloudFront URL in your own AWS account.',
}

function routes(provider) {
  return async (path, route) => {
    if (path === '/api/publish-providers') return json(route, { providers: [provider] }), true
    if (path === '/api/artifacts') return json(route, { artifacts: [ARTIFACT] }), true
    if (path === '/api/artifact-folders') return json(route, { folders: [] }), true
    if (path === '/api/artifacts/session-docs') return json(route, { docs: [] }), true

    const m = /^\/api\/artifacts\/([^/]+)(\/.*)?$/.exec(path)
    if (m && decodeURIComponent(m[1]) === ARTIFACT.slug) {
      const rest = m[2] || ''
      if (rest === '') return json(route, { ...ARTIFACT, content: RAW_HTML }), true
      if (rest === '/versions') return json(route, { slug: ARTIFACT.slug, versions: [1] }), true
      if (rest === '/events') return json(route, { slug: ARTIFACT.slug, events: [] }), true
      if (rest === '/comments') return json(route, { comments: [] }), true
      if (rest === '/upstream-status') return json(route, {}), true
    }

    // The publish endpoint is called twice: preview, then confirm.
    if (path === '/api/apps/internal-publish/publish' || path === '/api/deploy/deploy') {
      let body = {}
      try {
        body = JSON.parse(route.request().postData() || '{}')
      } catch {
        body = {}
      }
      if (!body.confirm) {
        return json(route, {
          requires_confirm: true,
          message: PREVIEW_MESSAGE[provider.id] || '',
          bytes: 24576,
          content_digest: 'abc123',
        }), true
      }
      return json(route, PUBLISHED_ARTIFACT), true
    }
    return false
  }
}

/** Open the artifact detail page with the Publish panel expanded. */
async function openPublishPanel(page, base) {
  await page.goto(base + '/artifacts/' + ARTIFACT.slug, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const publishToggle = page.getByRole('button', { name: /^Publish$/ }).first()
  await publishToggle.click()
  await page.waitForTimeout(400)
}

async function clickPublishRow(page, label) {
  await page.getByText(label, { exact: true }).click()
  await page.waitForTimeout(300)
}

/** Advance from the TTL step to the confirm step. */
async function requestPreview(page) {
  // Role + accessible name, not `hasText`: these buttons wrap an icon beside the
  // label, so the element's innerText carries whitespace an anchored regex
  // (`/^Publish$/`) never matches. The LAST match is the panel's own control —
  // the first is the page-level "Publish" toggle.
  await page.getByRole('button', { name: 'Publish', exact: true }).last().click()
  await page.waitForTimeout(700)
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png`, fullPage: false })
  console.log('wrote', `${OUT}/${PREFIX}-${name}.png`)
}

/**
 * Commit the publish and settle on the RESULT state.
 *
 * The acknowledgment is clicked through when present, so the same harness reaches
 * the result on both sides of the fix: before it, every destination (internal
 * included) went through the modal.
 */
async function commitAndSettle(page) {
  await page.getByText(/Confirm & Publish/).click()
  await page.waitForTimeout(500)
  const ack = page.getByRole('button', { name: /I understand, publish publicly/ })
  if (await ack.count()) {
    await ack.first().click()
  }
  await page.waitForTimeout(900)
}

async function main() {
  const { srv, base } = await serveDist()
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath ? { executablePath } : {})
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 2,
  })

  // --- internal destination -------------------------------------------------
  const internal = await context.newPage()
  await stubDashboardApi(internal, { extra: routes(INTERNAL_PROVIDER) })
  logPageProblems(internal)
  await openPublishPanel(internal, base)
  await clickPublishRow(internal, 'Artifactory (internal)')
  await requestPreview(internal)
  await shot(internal, '01-internal-confirm')

  await commitAndSettle(internal)
  await shot(internal, '02-internal-published')
  await internal.close()

  // --- public destination (the guard must be intact) ------------------------
  const pub = await context.newPage()
  await stubDashboardApi(pub, { extra: routes(PUBLIC_PROVIDER) })
  logPageProblems(pub)
  await openPublishPanel(pub, base)
  await clickPublishRow(pub, 'Publish to public web (your AWS)')
  await requestPreview(pub)
  await shot(pub, '03-public-confirm')

  await pub.getByText(/Confirm & Publish/).click()
  await pub.waitForTimeout(700)
  await shot(pub, '04-public-ack')
  await pub.close()

  await browser.close()
  srv.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
