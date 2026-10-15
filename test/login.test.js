const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { login, credentials, savedUsername, NetgearLogin, COGNITO_URL } = require('../api-login');
const { prompt } = require('../prompt');
const { Auth, refreshSession } = require('../auth');
const { readJSON, writeJSON } = require('../store');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meural-login-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'auth.json'), envFile = path.join(dir, '.env');
  await writeJSON(file, { username: 'test@example.com', accessToken: 'working-access', refreshToken: 'working-refresh',
    trustId: 'existing-trust', importedAt: '2026-01-01T00:00:00.000Z' });
  return { file, envFile };
}

function server(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    assert.ok(responses.length, 'unexpected API request');
    const { status = 200, ...body } = responses.shift();
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}
const passwordChallenge = { ChallengeName: 'CUSTOM_CHALLENGE', Session: 'password-session' };
const authenticated = { AuthenticationResult: { AccessToken: 'cognito-access' } };
const exchange = [{ data: { code: 'oauth-code' } }, { data: { accessToken: 'new-access', refreshToken: 'new-refresh' } }];

test('credentials parse quoted .env passwords and reuse saved account email', async t => {
  const { envFile } = await fixture(t);
  await fs.writeFile(envFile, 'NETGEAR_PASSWORD="space # password"\n', { mode: 0o644 });
  const result = await credentials({ envFile, env: {}, saved: { username: 'saved@example.com' }, ask: () => assert.fail('unexpected prompt') });
  assert.deepEqual(result, { username: 'saved@example.com', password: 'space # password' });
  assert.equal((await fs.stat(envFile)).mode & 0o777, 0o600);
});

test('CLI email and environment password override .env', async t => {
  const { envFile } = await fixture(t);
  await fs.writeFile(envFile, 'NETGEAR_USERNAME=file@example.com\nNETGEAR_PASSWORD=file-password\n');
  const result = await credentials({ envFile, env: { NETGEAR_USERNAME: 'env@example.com', NETGEAR_PASSWORD: 'env-password' }, username: 'cli@example.com' });
  assert.deepEqual(result, { username: 'cli@example.com', password: 'env-password' });
});

test('NETGEAR_EMAIL in .env supplies the account and takes precedence over its legacy alias', async t => {
  const { envFile } = await fixture(t);
  await fs.writeFile(envFile, 'NETGEAR_EMAIL=email@example.com\nNETGEAR_USERNAME=legacy@example.com\nNETGEAR_PASSWORD=file-password\n');
  const options = { envFile, env: {}, saved: { username: 'saved@example.com' }, ask: () => assert.fail('unexpected prompt') };
  assert.equal((await credentials(options)).username, 'email@example.com');
  assert.equal((await credentials({ ...options, env: { NETGEAR_EMAIL: 'env@example.com' } })).username, 'env@example.com');
});

test('missing .env prompts for email and a hidden password', async t => {
  const { envFile } = await fixture(t), questions = [];
  const result = await credentials({ envFile, env: {}, ask: async (label, options) => {
    questions.push({ label, options }); return options?.secret ? 'prompt-password' : 'prompt@example.com';
  } });
  assert.equal(result.password, 'prompt-password');
  assert.equal(questions.length, 2);
  assert.equal(questions[1].options.secret, true);
});

test('saved JWT email can supply the default account', () => {
  const jwt = `header.${Buffer.from(JSON.stringify({ preferred_username: 'jwt@example.com' })).toString('base64url')}.signature`;
  assert.equal(savedUsername({ accessToken: jwt }), 'jwt@example.com');
  assert.equal(savedUsername({ accessToken: 'invalid' }), undefined);
});

test('custom password and verification challenges exchange tokens without persisting secrets', async t => {
  const { file, envFile } = await fixture(t), logs = [];
  const fake = server([passwordChallenge, { ChallengeName: 'CUSTOM_CHALLENGE', Session: 'otp-session', ChallengeParameters: { type: 'email_otp' } }, authenticated, ...exchange]);
  await login(file, { envFile, env: { NETGEAR_PASSWORD: 'test-password' }, fetchImpl: fake.fetchImpl,
    ask: async (label, options) => { assert.equal(options.secret, true); return '123456'; }, log: s => logs.push(s),
    refresh: async candidate => {
      assert.equal((await readJSON(file)).refreshToken, 'working-refresh');
      assert.equal(candidate.refreshToken, 'new-refresh');
      return { ...candidate, accessToken: 'verified-access' };
    } });
  const saved = await readJSON(file);
  assert.equal(saved.accessToken, 'verified-access');
  assert.equal(saved.trustId, 'existing-trust');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(fake.calls[0].url, COGNITO_URL);
  assert.equal(fake.calls[0].body.AuthFlow, 'CUSTOM_AUTH');
  assert.equal(fake.calls[1].body.ChallengeResponses.ANSWER, 'test-password');
  assert.equal(fake.calls[1].body.Session, 'password-session');
  assert.equal(fake.calls[2].body.ChallengeResponses.ANSWER, '123456');
  assert.equal(fake.calls[2].body.Session, 'otp-session');
  assert.equal(fake.calls[3].headers.Authorization, 'Bearer cognito-access');
  assert.equal(new URL(fake.calls[4].url).searchParams.get('code'), 'oauth-code');
  for (const secret of ['test-password', '123456', 'cognito-access', 'oauth-code']) {
    assert.ok(!JSON.stringify(saved).includes(secret));
    assert.ok(!logs.join('').includes(secret));
  }
});

test('an initial custom OTP challenge prompts rather than sending the password', async () => {
  const fake = server([{ ...passwordChallenge, ChallengeParameters: { type: 'verification' } }, authenticated, ...exchange]);
  await new NetgearLogin({ fetchImpl: fake.fetchImpl, ask: async () => '987654' }).authenticate('test@example.com', 'password');
  assert.equal(fake.calls[1].body.ChallengeResponses.ANSWER, '987654');
});

test('legacy account migration uses password auth only on user-not-found', async () => {
  const fake = server([{ status: 400, __type: 'UserNotFoundException' }, authenticated, ...exchange]);
  await new NetgearLogin({ fetchImpl: fake.fetchImpl }).authenticate('test@example.com', 'password');
  assert.equal(fake.calls[1].body.AuthFlow, 'USER_PASSWORD_AUTH');
  assert.equal(fake.calls[1].body.AuthParameters.PASSWORD, 'password');
  for (const response of [{ status: 400, __type: 'NotAuthorizedException' }, { status: 403, message: 'user_not_found' }]) {
    const failed = server([response]);
    await assert.rejects(new NetgearLogin({ fetchImpl: failed.fetchImpl }).authenticate('test@example.com', 'password'));
    assert.equal(failed.calls.length, 1);
  }
});

test('standard MFA challenges use the required Cognito response key', async () => {
  for (const name of ['EMAIL_MFA', 'EMAIL_OTP', 'SMS_MFA', 'SMS_OTP', 'SOFTWARE_TOKEN_MFA']) {
    const fake = server([{ ChallengeName: name, Session: 'mfa' }, authenticated, ...exchange]);
    await new NetgearLogin({ fetchImpl: fake.fetchImpl, ask: async () => '123456' }).authenticate('test@example.com', 'password');
    assert.equal(fake.calls[1].body.ChallengeResponses[`${name}_CODE`], '123456');
  }
});

test('unsupported account setup challenges and excessive challenges stop safely', async () => {
  for (const name of ['NEW_PASSWORD_REQUIRED', 'MFA_SETUP']) {
    const fake = server([{ ChallengeName: name, Session: 'setup' }]);
    await assert.rejects(new NetgearLogin({ fetchImpl: fake.fetchImpl }).authenticate('test@example.com', 'password'), /NETGEAR requires|unsupported/);
    assert.equal(fake.calls.length, 1);
  }
  const fake = server(Array.from({ length: 9 }, () => ({ ChallengeName: 'EMAIL_OTP', Session: 'otp' })));
  await assert.rejects(new NetgearLogin({ fetchImpl: fake.fetchImpl, ask: async () => '123456' }).authenticate('test@example.com', 'password'), /too many/);
});

test('failed login, incomplete tokens, and failed verification preserve working credentials', async t => {
  const { file, envFile } = await fixture(t);
  for (const responses of [
    [{ status: 400, __type: 'NotAuthorizedException', message: 'test-password' }],
    [authenticated, exchange[0], { data: { accessToken: 'incomplete' } }],
    [authenticated, ...exchange]
  ]) {
    const fake = server(responses);
    await assert.rejects(login(file, { envFile, env: { NETGEAR_PASSWORD: 'test-password' }, fetchImpl: fake.fetchImpl,
      log: () => {}, refresh: async () => { throw Error('Verification unavailable'); } }), error => {
      assert.ok(!error.message.includes('test-password')); return true;
    });
    assert.equal((await readJSON(file)).refreshToken, 'working-refresh');
  }
});

test('server and transport errors never echo credentials or response bodies', async () => {
  for (const status of [400, 403, 429, 503]) {
    const fake = server([{ status, message: 'sensitive-server-response' }]);
    await assert.rejects(new NetgearLogin({ fetchImpl: fake.fetchImpl }).authenticate('test@example.com', 'password'), error => !error.message.includes('sensitive-server-response'));
  }
  await assert.rejects(new NetgearLogin({ fetchImpl: async () => { throw Error('sensitive-url'); } }).authenticate('test@example.com', 'password'), error => !error.message.includes('sensitive-url'));
});

test('hidden prompt supports backspace without echo and restores terminal state', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let displayed = ''; output.on('data', chunk => { displayed += chunk; });
  assert.equal(input.readableFlowing, null);
  const result = prompt('Password: ', { secret: true, input, output });
  input.write('passx\x7fword\r');
  assert.equal(await result, 'password');
  assert.equal(displayed, 'Password: \n');
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('hidden prompt cancellation restores terminal state; noninteractive prompts fail clearly', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  const result = prompt('Password: ', { secret: true, input, output });
  input.write('\x03');
  await assert.rejects(result, /cancelled/);
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  await assert.rejects(prompt('Password: ', { input: new PassThrough(), output }), /terminal/);
  await assert.rejects(prompt('NETGEAR email code (hidden): ', { secret: true, input: new PassThrough(), output }), /requires a verification code/);
});

test('consecutive hidden prompts release initially idle input after each answer', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  assert.equal(input.readableFlowing, null);
  for (const label of ['Password: ', 'Code: ']) {
    const result = prompt(label, { secret: true, input, output });
    input.write('test-value\r');
    assert.equal(await result, 'test-value');
    assert.equal(input.isRaw, false);
    assert.equal(input.readableFlowing, false);
    assert.equal(input.listenerCount('keypress'), 0);
  }
});

test('status exposes expiry metadata without revealing credentials', async t => {
  const { file } = await fixture(t), status = await new Auth(file).status();
  assert.equal(status.refreshTokenPresent, true);
  assert.equal(status.refreshTokenExpiresAt, 'Not exposed by NETGEAR');
  assert.ok(!JSON.stringify(status).includes('working-refresh'));
  assert.ok(!JSON.stringify(status).includes('working-access'));
});

test('access refresh retains an unrotated refresh token and metadata', async () => {
  const saved = { refreshToken: 'original-refresh', importedAt: '2026-01-01T00:00:00.000Z' };
  const refreshed = await refreshSession(saved, async () => ({ ok: true, json: async () => ({ data: { accessToken: 'new-access' } }) }));
  assert.equal(refreshed.refreshToken, 'original-refresh');
  assert.equal(refreshed.importedAt, saved.importedAt);
  assert.equal(refreshed.refreshTokenReplacedAt, undefined);
  assert.ok(refreshed.lastRefreshedAt);
});
