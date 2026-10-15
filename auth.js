const { execFileSync } = require('node:child_process');
const { readJSON, writeJSON } = require('./store');

// Public application identifier used by the website, not an account secret.
const CLIENT_ID = '3ui6nklcaqoij8inrkm06gfk4s';
function expiresAt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000 || 0; }
  catch { return 0; }
}

function validatePort(port) {
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('CDP port must be between 1 and 65535.');
}

const SESSION_EXPRESSION = `(() => {
    if (location.origin !== 'https://my.meural.netgear.com') return {ready:false};
    const cookies = Object.fromEntries(document.cookie.split(';').map(s => {const i=s.indexOf('=');return [s.slice(0,i).trim(),decodeURIComponent(s.slice(i+1))]}));
    if (!cookies.refreshtoken || !cookies.token) return {ready:false};
    return {ready:true,accessToken:cookies.token,refreshToken:cookies.refreshtoken,clientId:'${CLIENT_ID}'};
  })()`;

// Browser output can contain credentials. Capture it privately and replace all
// CLI failures with a fixed message rather than forwarding stdout/stderr.
function browserJSON(args) {
  let result;
  try {
    const output = execFileSync('agent-browser', args,
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    result = JSON.parse(output);
  } catch { throw new Error('Browser import failed. Check agent-browser, CDP connectivity, and the selected Meural tab.'); }
  if (!result.success) throw new Error('The browser command failed. Check agent-browser and browser connectivity.');
  return result.data;
}

async function importBrowser(file, port = '9222') {
  validatePort(port);
  const tokens = browserJSON(['--cdp', String(port), '--json', 'eval', SESSION_EXPRESSION]).result;
  if (!tokens?.ready) throw new Error('No signed-in Meural session found. Run: node index.js login');
  await writeJSON(file, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
    clientId: tokens.clientId, expiresAt: expiresAt(tokens.accessToken), importedAt: new Date().toISOString() });
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
    let saved = await this.load();
    if (!forceRefresh && saved.accessToken && saved.expiresAt > Date.now() + 60000) return saved.accessToken;
    saved = await refreshSession(saved, this.fetch);
    await writeJSON(this.file, saved);
    return saved.accessToken;
  }
}
module.exports = { Auth, importBrowser, expiresAt, refreshSession, browserJSON, SESSION_EXPRESSION, validatePort, CLIENT_ID };
