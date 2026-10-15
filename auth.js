const { execFileSync } = require('node:child_process');
const { readJSON, writeJSON } = require('./store');

// Public application identifier used by the website, not an account secret.
const CLIENT_ID = '3ui6nklcaqoij8inrkm06gfk4s';
function expiresAt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).exp * 1000 || 0; }
  catch { return 0; }
}

async function importBrowser(file, port = '9222') {
  if (!/^\d+$/.test(String(port))) throw new Error('CDP port must be a number.');
  const expression = `(() => {
    if (location.origin !== 'https://my.meural.netgear.com') throw Error('Select the signed-in Meural tab first.');
    const cookies = Object.fromEntries(document.cookie.split(';').map(s => {const i=s.indexOf('=');return [s.slice(0,i).trim(),decodeURIComponent(s.slice(i+1))]}));
    if (!cookies.refreshtoken || !cookies.token) throw Error('Sign in to Meural before importing authentication.');
    return {accessToken:cookies.token,refreshToken:cookies.refreshtoken,clientId:'${CLIENT_ID}'};
  })()`;
  let result;
  try {
    const output = execFileSync('agent-browser', ['--cdp', String(port), '--json', 'eval', expression],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    result = JSON.parse(output);
  } catch { throw new Error('Browser import failed. Check agent-browser, CDP connectivity, and the selected Meural tab.'); }
  const tokens = result.data?.result;
  if (!result.success || !tokens?.refreshToken || !tokens?.accessToken) throw new Error('No signed-in Meural session found in the selected browser tab.');
  await writeJSON(file, { ...tokens, expiresAt: expiresAt(tokens.accessToken) });
}

class Auth {
  constructor(file, fetchImpl = fetch) { this.file = file; this.fetch = fetchImpl; }
  async token(forceRefresh = false) {
    let saved;
    try { saved = await readJSON(this.file); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('No saved authentication. Run: node index.js auth --cdp 9222');
      throw new Error('Saved authentication is unreadable. Import authentication from the browser again.');
    }
    if (!forceRefresh && saved.accessToken && saved.expiresAt > Date.now() + 60000) return saved.accessToken;
    if (!saved.refreshToken) throw new Error('No refresh token. Import authentication from the browser again.');
    const response = await this.fetch('https://accounts2.netgear.com/api/getAccessToken', {
      // NETGEAR's CloudFront rejects the same valid token without web-client
      // request headers. These match the signed-in website's refresh request.
      headers: { Authorization: `Bearer ${saved.refreshToken}`, appkey: saved.clientId || CLIENT_ID, Accept: 'application/json',
        Origin: 'https://my.meural.netgear.com', Referer: 'https://my.meural.netgear.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(30000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`NETGEAR token refresh failed (HTTP ${response.status}). Sign in and import authentication again if the session has expired.`);
    let body;
    try { body = await response.json(); } catch { throw new Error('NETGEAR returned an invalid token response.'); }
    const data = body.data || body;
    if (!data.accessToken) throw new Error('NETGEAR did not return an access token. Import authentication again.');
    saved = { accessToken: data.accessToken, refreshToken: data.refreshToken || saved.refreshToken,
      clientId: saved.clientId || CLIENT_ID, expiresAt: expiresAt(data.accessToken) };
    await writeJSON(this.file, saved);
    return saved.accessToken;
  }
}
module.exports = { Auth, importBrowser, expiresAt };
