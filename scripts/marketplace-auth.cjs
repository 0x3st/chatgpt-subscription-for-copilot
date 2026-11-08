// Release-only OIDC preflight using the exact helper used by the locked official vsce.
// Never persist, export or print either the GitHub identity token or exchanged credential.
const { getOIDCCredential } = require('@vscode/vsce/out/oidc');

async function checkMarketplaceAuth({ fetchImpl = fetch, environment = process.env } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const credential = await getOIDCCredential('lab530', {
      environment,
      marketplaceUrl: 'https://marketplace.visualstudio.com',
      request: async (url, init) => {
        const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
        return { statusCode: response.status, statusMessage: response.statusText, readBody: () => response.text() };
      }
    });
    if (typeof credential !== 'string' || !credential) throw new Error('Missing credential');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = /(?:GitHub Actions OIDC token request|Marketplace OIDC token exchange) failed with (\d{3})\b/.exec(message)?.[1];
    // Upstream error details may contain sensitive content; retain only an HTTP status.
    throw new Error(`Marketplace OIDC preflight failed${status ? ` (HTTP ${status})` : ''}. Verify the lab530 Trusted Publishing policy for this repository, workflow and environment.`);
  } finally { clearTimeout(timer); }
}

module.exports = { checkMarketplaceAuth };
if (require.main === module) {
  checkMarketplaceAuth().then(
    () => console.log('Marketplace OIDC trust verified for lab530. No extension publication attempted by this check.'),
    error => { console.error(error.message); process.exitCode = 1; }
  );
}
