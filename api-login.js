const fs = require('node:fs/promises');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { randomUUID } = require('node:crypto');
const { prompt } = require('./prompt');
const { readJSON, writeJSON } = require('./store');
const { CLIENT_ID, expiresAt, refreshSession } = require('./auth');

const COGNITO_URL = 'https://cognito-idp.eu-west-1.amazonaws.com/';
const COGNITO_CLIENT_ID = '487bd4kvb1fnop6mbgk8gu5ibf';
const ACCOUNTS_URL = 'https://accounts2.netgear.com';
const WEB_HEADERS = {
  Accept: 'application/json', Origin: 'https://my.meural.netgear.com',
  Referer: 'https://my.meural.netgear.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
};
const RESPONSE_KEYS = {
  EMAIL_MFA: 'EMAIL_MFA_CODE', EMAIL_OTP: 'EMAIL_OTP_CODE',
  SMS_MFA: 'SMS_MFA_CODE', SMS_OTP: 'SMS_OTP_CODE',
  SOFTWARE_TOKEN_MFA: 'SOFTWARE_TOKEN_MFA_CODE', CUSTOM_CHALLENGE: 'ANSWER', PASSWORD: 'PASSWORD'
};

function savedUsername(saved) {
  if (saved.username) return saved.username;
  try {
    const claims = JSON.parse(Buffer.from(saved.accessToken.split('.')[1], 'base64url'));
    return [claims.preferred_username, claims.email, claims.username].find(x => typeof x === 'string' && x.includes('@'));
  } catch { return undefined; }
}

async function credentials({ envFile = path.join(__dirname, '.env'), env = process.env, username, saved = {}, ask = prompt } = {}) {
  let file = {};
  try {
    const text = await fs.readFile(envFile, 'utf8');
    file = parseEnv(text);
    if (process.platform !== 'win32') await fs.chmod(envFile, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read the .env file. Check its syntax and file permissions.');
  }
  username = username || env.NETGEAR_EMAIL || env.NETGEAR_USERNAME || file.NETGEAR_EMAIL || file.NETGEAR_USERNAME || savedUsername(saved);
  if (!username) username = await ask('NETGEAR email: ');
  username = String(username).trim();
  if (!username) throw new Error('NETGEAR email is required.');
  let password = env.NETGEAR_PASSWORD ?? file.NETGEAR_PASSWORD;
  if (!password) password = await ask('NETGEAR password (hidden): ', { secret: true });
  if (!password) throw new Error('NETGEAR password is required.');
  return { username, password };
}

function requestError(status, body) {
  const description = JSON.stringify(body || {}).toLowerCase();
  const rawType = typeof body?.__type === 'string' ? body.__type.split('#').at(-1) : '';
  let message = 'NETGEAR rejected the login or verification response. Check your credentials/code and run login again.';
  if (status === 403 || /forbiddenexception|\bwaf\b/.test(description)) message = 'NETGEAR blocked the API login request (WAF/IP restriction). Retry later or contact NETGEAR support.';
  else if (status === 429 || rawType === 'TooManyRequestsException') message = 'NETGEAR is rate limiting login attempts. Wait before trying again.';
  else if (status >= 500) message = 'NETGEAR authentication is temporarily unavailable. Retry later.';
  else if (rawType === 'PasswordResetRequiredException') message = 'NETGEAR requires a password reset. Reset it with NETGEAR, update .env, and run login again.';
  const error = new Error(`${message} (HTTP ${status})`);
  error.migrationRequired = status === 400 && /user_not_found|usernotfoundexception/.test(description);
  return error;
}

class NetgearLogin {
  constructor({ fetchImpl = fetch, ask = prompt, trustId = randomUUID() } = {}) {
    this.fetch = fetchImpl; this.ask = ask; this.trustId = trustId;
  }
  async request(method, url, { headers = {}, body } = {}) {
    let response, text;
    try {
      response = await this.fetch(url, { method, headers: { ...WEB_HEADERS, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
      text = await response.text();
    } catch { throw new Error('Could not reach NETGEAR authentication. Check connectivity and retry login.'); }
    let data;
    try { data = JSON.parse(text); } catch { /* WAF responses can be HTML. */ }
    if (!response.ok) throw requestError(response.status, data || { message: text });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('NETGEAR returned an invalid authentication response.');
    return data;
  }
  metadata() { return { trustID: this.trustId, sourceEvent: 'login', language: 'en-US', appType: 'meural' }; }
  cognito(action, payload) {
    return this.request('POST', COGNITO_URL, {
      headers: { 'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
        Origin: ACCOUNTS_URL, Referer: ACCOUNTS_URL + '/' },
      body: { ClientId: COGNITO_CLIENT_ID, ClientMetadata: this.metadata(), ...payload }
    });
  }
  async authenticate(username, password) {
    let response;
    try { response = await this.cognito('InitiateAuth', { AuthFlow: 'CUSTOM_AUTH', AuthParameters: { USERNAME: username } }); }
    catch (error) {
      if (!error.migrationRequired) throw error;
      response = await this.cognito('InitiateAuth', { AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: username, PASSWORD: password } });
    }
    let passwordSent = false;
    for (let step = 1; !response.AuthenticationResult; step++) {
      if (step > 8) throw new Error('NETGEAR returned too many authentication challenges. Run login again.');
      const name = response.ChallengeName;
      if (!name || !response.Session) throw new Error('NETGEAR returned neither a session nor authentication tokens.');
      if (name === 'NEW_PASSWORD_REQUIRED') throw new Error('NETGEAR requires a password change. Change it with NETGEAR, update .env, and run login again.');
      const key = RESPONSE_KEYS[name];
      if (!key) throw new Error('NETGEAR requested an unsupported authentication challenge. Complete account setup with NETGEAR before retrying.');
      const parameters = JSON.stringify(response.ChallengeParameters || {}).toLowerCase();
      const passwordChallenge = name === 'PASSWORD' ||
        (name === 'CUSTOM_CHALLENGE' && step === 1 && !/otp|verification|email|phone|code/.test(parameters));
      let answer;
      if (passwordChallenge) {
        if (passwordSent) throw new Error('NETGEAR requested the password repeatedly; check the password and retry login.');
        answer = password; passwordSent = true;
      } else {
        const medium = name.startsWith('EMAIL') ? 'email' : name.startsWith('SMS') ? 'SMS' : name === 'SOFTWARE_TOKEN_MFA' ? 'authenticator' : 'verification';
        answer = String(await this.ask(`NETGEAR ${medium} code (hidden): `, { secret: true })).trim();
        if (!answer) throw new Error('NETGEAR verification code is required.');
      }
      response = await this.cognito('RespondToAuthChallenge', { ChallengeName: name, Session: response.Session,
        ChallengeResponses: { USERNAME: username, [key]: answer } });
    }
    const cognitoToken = response.AuthenticationResult.AccessToken;
    if (!cognitoToken) throw new Error('NETGEAR did not return a Cognito access token.');
    const authorization = await this.request('GET', `${ACCOUNTS_URL}/api/oauth/authorize?${new URLSearchParams({ client_id: CLIENT_ID })}`,
      { headers: { Authorization: `Bearer ${cognitoToken}` } });
    const authBody = authorization.data || authorization;
    const code = authBody.code || authBody.authorizationCode;
    if (!code) throw new Error('NETGEAR did not return a Meural authorization code.');
    const exchanged = await this.request('GET', `${ACCOUNTS_URL}/api/oauth/token?${new URLSearchParams({ code: String(code) })}`,
      { headers: { 'Content-Type': 'application/json' } });
    const data = exchanged.data || exchanged;
    const accessToken = data.accessToken || data.access_token || data.token;
    const refreshToken = data.refreshToken || data.refresh_token;
    if (!accessToken || !refreshToken) throw new Error('NETGEAR returned incomplete Meural tokens. Existing credentials were kept.');
    return { accessToken, refreshToken, expiresAt: expiresAt(accessToken), clientId: CLIENT_ID,
      username, trustId: this.trustId, importedAt: new Date().toISOString() };
  }
}

async function login(file, { envFile, env, username, fetchImpl = fetch, ask = prompt, log = console.log, refresh = refreshSession } = {}) {
  let saved = {};
  try { saved = await readJSON(file); } catch { /* A fresh login repairs missing/corrupt credentials. */ }
  const account = await credentials({ envFile, env, username, saved, ask });
  log('Signing in to NETGEAR through the API.');
  const api = new NetgearLogin({ fetchImpl, ask, trustId: saved.trustId });
  const session = await api.authenticate(account.username, account.password);
  // Keep the previous tokens untouched until the whole login and refresh work.
  const verified = await refresh(session, fetchImpl);
  await writeJSON(file, verified);
  log('API login complete. Saved and verified session tokens; the password was not saved.');
}

module.exports = { login, credentials, savedUsername, NetgearLogin, COGNITO_URL, COGNITO_CLIENT_ID, ACCOUNTS_URL };
