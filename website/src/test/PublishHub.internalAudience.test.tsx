// PublishHub — an `internal`-audience destination, and the artifact-shaped
// success response an app provider gets when it hands the confirmed publish to
// the core publish route.
//
// Two defects are pinned here, both of which presented as a SUCCESSFUL publish
// looking broken or lying to the operator:
//
//  1. `POST /api/artifacts/{slug}/publish` answers with the serialized artifact
//     (a `publication` block), not `{url}`. The panel recognized neither, fell
//     through to `{url: ''}` and rendered its error branch with an UNDEFINED
//     message — a bare red icon, no text, on a publish that had succeeded.
//  2. Every destination got the public-exposure warning and the blocking
//     acknowledgment, including an access-controlled internal one where both
//     statements are false.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { PublishHub, providerAudience, readPublishOutcome } from '../components/PublishHub'
import type { Artifact } from '../types'

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

const fakeArtifact: Artifact = {
  slug: 'test-app',
  name: 'Test App',
  kind: 'widget',
  description: '',
  content: '',
  version: 1,
  created_at: '',
  updated_at: '',
  tags: [],
}

const EXPOSURE = /Anyone with the published link can view this content/

function providerRow(audience?: string) {
  return {
    id: 'artifactory',
    label: 'Artifactory (internal)',
    icon: 'Upload',
    kinds: [],
    configured: true,
    setupRoute: '/internal-publish',
    endpoint: '/api/apps/internal-publish/publish',
    ...(audience === undefined ? {} : { audience }),
  }
}

function providersResponse(audience?: string) {
  return new Response(JSON.stringify({ providers: [providerRow(audience)] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function previewResponse() {
  return new Response(
    JSON.stringify({
      requires_confirm: true,
      message: 'Publishes this artifact to Artifactory as PRIVATE.',
      content_digest: 'abc123',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/** The serialized artifact the core publish route returns on success. */
function artifactPublishResponse(viewUrl: string | null = 'https://internal.example.com/view/1') {
  return new Response(
    JSON.stringify({
      slug: 'test-app',
      name: 'Test App',
      kind: 'widget',
      version: 1,
      publication: {
        provider: 'artifactory',
        visibility: 'PRIVATE',
        ...(viewUrl === null ? {} : { view_url: viewUrl }),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/** Drive the panel to the confirm step and return the confirm button. */
async function reachConfirmStep(fetchSpy: ReturnType<typeof vi.spyOn>, audience?: string) {
  fetchSpy.mockImplementationOnce(async () => providersResponse(audience))
  render(<PublishHub artifact={fakeArtifact} />, { wrapper })
  await waitFor(() => expect(screen.getByText('Artifactory (internal)')).toBeDefined())
  fireEvent.click(screen.getByText('Artifactory (internal)'))

  fetchSpy.mockImplementationOnce(async () => previewResponse())
  const publishBtn = screen
    .getAllByRole('button')
    .find(b => b.textContent?.includes('Publish') && !b.textContent?.includes('Close'))
  fireEvent.click(publishBtn!)
  await waitFor(() => expect(screen.getByText(/Confirm & Publish/)).toBeDefined())
  return screen.getByText(/Confirm & Publish/).closest('button')!
}

describe('providerAudience', () => {
  it('defaults to public and only ever trusts the exact "internal" literal', () => {
    expect(providerAudience(undefined)).toBe('public')
    // Absent field: an older backend that does not emit `audience` must keep the
    // warning, not lose it.
    expect(providerAudience(providerRow() as never)).toBe('public')
    expect(providerAudience(providerRow('public') as never)).toBe('public')
    expect(providerAudience(providerRow('internal') as never)).toBe('internal')
    for (const bogus of ['Internal', 'INTERNAL', 'private', '', 'internal ']) {
      expect(providerAudience(providerRow(bogus) as never)).toBe('public')
    }
  })
})

describe('readPublishOutcome', () => {
  it('accepts both the deploy shape and the artifact shape', () => {
    expect(readPublishOutcome({ url: 'https://a/b' })).toEqual({ url: 'https://a/b' })
    expect(readPublishOutcome({ public_url: 'https://a/c' })).toEqual({ url: 'https://a/c' })
    expect(readPublishOutcome({ publication: { view_url: 'https://a/d' } })).toEqual({
      url: 'https://a/d',
    })
    // Published, but the destination exposes no browsable URL: success WITHOUT a
    // link. Callers must not infer success from a non-empty url.
    expect(readPublishOutcome({ publication: { provider: 'x' } })).toEqual({ url: '' })
  })

  it('reports a persisted push failure as an error, not a 200 success', () => {
    // publish_sync.publish() treats the version push as best-effort on a
    // RE-publish: it captures the failure into publication.last_error and
    // returns normally, so the route answers 200 with stale remote content.
    expect(
      readPublishOutcome({
        publication: { view_url: 'https://a/d', last_error: 'sync failed: 403 from provider' },
      }),
    ).toEqual({ error: 'sync failed: 403 from provider' })
    // Whitespace-only is not a failure — the core writes "" to clear it.
    expect(readPublishOutcome({ publication: { view_url: 'https://a/d', last_error: '  ' } })).toEqual({
      url: 'https://a/d',
    })
  })

  it('rejects everything that is not an outcome', () => {
    expect(readPublishOutcome(null)).toBeNull()
    expect(readPublishOutcome(undefined)).toBeNull()
    expect(readPublishOutcome({})).toBeNull()
    expect(readPublishOutcome({ error: 'nope' })).toBeNull()
    expect(readPublishOutcome({ url: '' })).toBeNull()
    // An UNpublished artifact carries publication: null — not a publish success.
    expect(readPublishOutcome({ publication: null })).toBeNull()
  })
})

describe('PublishHub — internal audience', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // `vi.spyOn` on an already-spied `fetch` hands back the SAME spy, so without
    // a restore the recorded calls accumulate across tests and a "no confirmed
    // publish was issued" assertion reads the previous test's requests.
    vi.restoreAllMocks()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  it('shows no public-exposure warning and no acknowledgment, and publishes directly', async () => {
    const confirmBtn = await reachConfirmStep(fetchSpy, 'internal')
    expect(screen.queryByText(EXPOSURE)).toBeNull()
    // A positive statement, not merely the absence of the warning.
    expect(screen.getByText(/Access-controlled destination/)).toBeDefined()

    fetchSpy.mockImplementationOnce(async () => artifactPublishResponse())
    fireEvent.click(confirmBtn)

    // No acknowledgment interposed: the publish POST is the very next request and
    // the success state lands without a second click.
    await waitFor(() => expect(screen.getByText(/Published!/)).toBeDefined())
    const [url, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1] as [string, RequestInit]
    expect(url).toBe('/api/apps/internal-publish/publish')
    expect(JSON.parse(String(init.body)).confirm).toBe(true)
  })

  it('renders the artifact-shaped success as Published, with the view link', async () => {
    const confirmBtn = await reachConfirmStep(fetchSpy, 'internal')
    fetchSpy.mockImplementationOnce(async () => artifactPublishResponse())
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(screen.getByText(/Published!/)).toBeDefined())
    expect(screen.getByText('https://internal.example.com/view/1')).toBeDefined()
    // The regression: this shape used to render the error branch with no message.
    expect(screen.queryByText(/Unexpected response/i)).toBeNull()
  })

  it('reports success even when the destination exposes no view URL', async () => {
    const confirmBtn = await reachConfirmStep(fetchSpy, 'internal')
    fetchSpy.mockImplementationOnce(async () => artifactPublishResponse(null))
    fireEvent.click(confirmBtn)

    await waitFor(() => expect(screen.getByText(/Published!/)).toBeDefined())
  })

  it('reports an UNRECOGNIZED response as a named error, never a blank one', async () => {
    const confirmBtn = await reachConfirmStep(fetchSpy, 'internal')
    fetchSpy.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ something: 'else' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    fireEvent.click(confirmBtn)

    // The failure being pinned is an EMPTY error line, so assert on text.
    await waitFor(() => expect(screen.getByText(/Unexpected response/i)).toBeDefined())
  })

  it('surfaces a 200 response whose publication carries last_error as an error', async () => {
    const confirmBtn = await reachConfirmStep(fetchSpy, 'internal')
    fetchSpy.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          slug: 'test-app',
          publication: {
            provider: 'artifactory',
            view_url: 'https://internal.example.com/view/1',
            last_error: 'sync failed: destination rejected the push',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    fireEvent.click(confirmBtn)

    // A re-publish whose version push failed must NOT read as Published — the
    // remote content is stale even though the route answered 200.
    await waitFor(() =>
      expect(screen.getByText(/sync failed: destination rejected the push/)).toBeDefined(),
    )
    expect(screen.queryByText(/Published!/)).toBeNull()
  })

  it('treats an error response as authoritative even beside a publication block', async () => {
    const confirmBtn = await reachConfirmStep(fetchSpy, 'internal')
    fetchSpy.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ error: 'publishing to artifactory is not permitted', publication: {} }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    fireEvent.click(confirmBtn)

    await waitFor(() =>
      expect(screen.getByText(/publishing to artifactory is not permitted/)).toBeDefined(),
    )
    expect(screen.queryByText(/Published!/)).toBeNull()
  })

  it('still requires the acknowledgment to OVERRIDE a scan finding', async () => {
    // The override confirms knowingly publishing flagged content, which is
    // independent of the destination's reach — a secret disclosed to everyone
    // behind the corporate SSO is still disclosed. So this gate is NOT forked on
    // audience, even though the clean path is.
    fetchSpy.mockImplementationOnce(async () => providersResponse('internal'))
    render(<PublishHub artifact={fakeArtifact} />, { wrapper })
    await waitFor(() => expect(screen.getByText('Artifactory (internal)')).toBeDefined())
    fireEvent.click(screen.getByText('Artifactory (internal)'))

    fetchSpy.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          blocked: true,
          reason: 'scan',
          findings: 'aws_key at index.html:12',
          count: 1,
          credential: false,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    fireEvent.click(
      screen
        .getAllByRole('button')
        .find(b => b.textContent?.includes('Publish') && !b.textContent?.includes('Close'))!,
    )
    await waitFor(() => expect(screen.getByText(/Override & Publish Anyway/)).toBeDefined())
    // No false public-exposure claim on the internal row...
    expect(screen.queryByText(EXPOSURE)).toBeNull()

    fireEvent.click(screen.getByText(/Override & Publish Anyway/))
    // ...but the blocking acknowledgment is still interposed.
    await waitFor(() => expect(screen.getByText(/I understand/i)).toBeDefined())
    const confirmed = fetchSpy.mock.calls.filter(c => {
      const init = c[1] as RequestInit | undefined
      if (!init?.body) return false
      return JSON.parse(String(init.body)).confirm === true
    })
    expect(confirmed).toHaveLength(0)
  })

  it('keeps the warning AND the acknowledgment for a provider that omits audience', async () => {
    const confirmBtn = await reachConfirmStep(fetchSpy, undefined)
    expect(screen.getByText(EXPOSURE)).toBeDefined()

    fireEvent.click(confirmBtn)
    // The blocking acknowledgment is interposed: the confirm click alone issues
    // no CONFIRMED publish (the preview POST hits the same endpoint, so the
    // discriminator is `confirm: true`, not the URL).
    await waitFor(() => expect(screen.getByText(/I understand/i)).toBeDefined())
    const confirmed = fetchSpy.mock.calls.filter(c => {
      const init = c[1] as RequestInit | undefined
      if (String(c[0]) !== '/api/apps/internal-publish/publish' || !init?.body) return false
      return JSON.parse(String(init.body)).confirm === true
    })
    expect(confirmed).toHaveLength(0)
  })
})
