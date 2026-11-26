// Safety net for ordinary tests. HTTP fixture servers remain usable; real
// providers and the developer's Magpie gateway must never receive requests.
export function createOfflineFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    )
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port ||
      url.port === '3425'
    ) {
      throw new Error(
        `Offline test blocked network access to ${url.origin}; use a local fixture or pnpm test:live`,
      )
    }
    // Automatic redirects could escape the loopback check. A caller that
    // handles redirects manually has every subsequent fetch checked again.
    return fetcher(input, {
      ...init,
      redirect: init?.redirect === 'manual' ? 'manual' : 'error',
    })
  }
}
