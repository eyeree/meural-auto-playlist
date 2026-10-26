const { readJSON, writeJSON } = require('./store');

// Public application identifier used by the website, not an account secret.
const CLIENT_ID = '3ui6nklcaqoij8inrkm06gfk4s';
function expiresAt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000 || 0; }
  catch { return 0; }
}

async function refreshSession(saved, fetchImpl = fetch) {
  if (!saved.refreshToken) throw new Error('No refresh token. Run: node index.js login');
  const response = await fetchImpl('https://accounts2.netgear.com/api/getAccessToken', {
    // These web-client headers were required by NETGEAR's CloudFront in live tests.
    headers: { Authorization: `Bearer ${saved.refreshToken}`, appkey: saved.clientId || CLIENT_ID, Accept: 'application/json',
      Origin: 'https://my.meural.netgear.com', Referer: 'https://my.meural.netgear.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(30000), redirect: 'error'
  });
  if (!response.ok) throw new Error(`NETGEAR token refresh failed (HTTP ${response.status}). The session may be expired/revoked or NETGEAR may be blocking requests. To sign in again, run: node index.js login`);
  let body;
  try { body = await response.json(); } catch { throw new Error('NETGEAR returned an invalid token response.'); }
  const data = body.data || body;
  if (!data.accessToken) throw new Error('NETGEAR did not return an access token. Run: node index.js login');
  const now = new Date().toISOString();
  return { ...saved, accessToken: data.accessToken, refreshToken: data.refreshToken || saved.refreshToken,
    clientId: saved.clientId || CLIENT_ID, expiresAt: expiresAt(data.accessToken), lastRefreshedAt: now,
    refreshTokenReplacedAt: data.refreshToken && data.refreshToken !== saved.refreshToken ? now : saved.refreshTokenReplacedAt };
}

class Auth {
  constructor(file, fetchImpl = fetch) { this.file = file; this.fetch = fetchImpl; }
  async load() {
    try { return await readJSON(this.file); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('No saved authentication. Run: node index.js login');
      throw new Error('Saved authentication is unreadable. Run: node index.js login');
    }
  }
  async status() {
    const saved = await this.load();
    return { accessTokenExpiresAt: saved.expiresAt ? new Date(saved.expiresAt).toISOString() : null,
      accessTokenExpired: !saved.expiresAt || saved.expiresAt <= Date.now(),
      refreshTokenPresent: !!saved.refreshToken, refreshTokenExpiresAt: 'Not exposed by NETGEAR',
      importedAt: saved.importedAt || null, lastRefreshedAt: saved.lastRefreshedAt || null,
      refreshTokenReplacedAt: saved.refreshTokenReplacedAt || null };
  }
  async token(forceRefresh = false) {
    if (this.refreshing) return this.refreshing;
    let saved = await this.load();
    if (this.refreshing) return this.refreshing;
    if (!forceRefresh && saved.accessToken && saved.expiresAt > Date.now() + 60000) return saved.accessToken;
    this.refreshing = (async () => {
      saved = await refreshSession(saved, this.fetch);
      await writeJSON(this.file, saved);
      return saved.accessToken;
    })();
    try { return await this.refreshing; }
    finally { this.refreshing = null; }
  }
}
module.exports = { Auth, expiresAt, refreshSession, CLIENT_ID };
