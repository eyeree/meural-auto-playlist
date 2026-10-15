const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { login, LOGIN_URL } = require('../browser-login');
const { Auth, validatePort, refreshSession } = require('../auth');
const { readJSON, writeJSON } = require('../store');

async function credentialsFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'meural-login-test-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'auth.json');
  await writeJSON(file, {accessToken:'working-access', refreshToken:'working-refresh', importedAt:'2026-01-01T00:00:00.000Z'});
  return file;
}

function fakeBrowser({ readyAfter = 1, available = true } = {}) {
  const calls = []; let evaluations = 0, tab = false;
  const execute = async args => {
    calls.push(args);
    const action = args.slice(args.indexOf('--json') + 1);
    if (action[0] === 'tab' && action.length === 1 && !available) throw Error('No Chrome');
    if (action[0] === 'tab' && action[1] === 'meural-login' && !tab) throw Error('No login tab');
    if (action[0] === 'tab' && action[1] === 'new') tab = true;
    if (action[0] === 'eval') return {result:++evaluations >= readyAfter ? {ready:true,accessToken:'new-access',refreshToken:'new-refresh'} : {ready:false}};
    return {};
  };
  return { execute, calls, makeAvailable: () => {available = true;} };
}

test('login waits through redirects, pins the login tab and verifies tokens before saving', async t => {
  const file = await credentialsFile(t), browser = fakeBrowser({readyAfter:2}), logs = [];
  let verified = false;
  await login(file, {execute:browser.execute, wait:async()=>{}, log:s=>logs.push(s), refresh:async candidate=>{
    assert.equal((await readJSON(file)).refreshToken,'working-refresh');
    assert.equal(candidate.refreshToken,'new-refresh');
    verified = true; return {...candidate, accessToken:'verified-access'};
  }});
  assert.equal(verified,true);
  assert.equal((await readJSON(file)).accessToken,'verified-access');
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  assert.ok(browser.calls.some(args=>args.includes(LOGIN_URL)));
  assert.ok(browser.calls.some(args=>args.includes('meural-login')));
  assert.ok(logs.every(s=>!s.includes('new-refresh')&&!s.includes('verified-access')));
});

test('failed verification preserves previously working credentials', async t => {
  const file = await credentialsFile(t), browser = fakeBrowser();
  await assert.rejects(login(file, {execute:browser.execute, log:()=>{},refresh:async()=>{throw Error('NETGEAR unavailable')}}),/unavailable/);
  assert.equal((await readJSON(file)).refreshToken,'working-refresh');
});

test('login does not mistake the old browser cookie for a renewed refresh token', async t => {
  const file=await credentialsFile(t), browser=fakeBrowser(); let evaluations=0, verifiedToken;
  const execute=async args=>{
    if(args.includes('eval') && ++evaluations===1) return {result:{ready:true,accessToken:'working-access',refreshToken:'working-refresh'}};
    return browser.execute(args);
  };
  await login(file,{execute,wait:async()=>{},log:()=>{},refresh:async candidate=>{verifiedToken=candidate.refreshToken;return candidate}});
  assert.equal(evaluations,2);
  assert.equal(verifiedToken,'new-refresh');
});

test('login timeout preserves credentials', async t => {
  const file = await credentialsFile(t), browser = fakeBrowser({readyAfter:Infinity});
  await assert.rejects(login(file, {execute:browser.execute, log:()=>{}, timeoutMs:5,pollMs:5}),/timed out/);
  assert.equal((await readJSON(file)).refreshToken,'working-refresh');
});

test('WSL login starts Windows Chrome when CDP is unavailable', async t => {
  const file = await credentialsFile(t), browser = fakeBrowser({available:false});let launched = false;
  await login(file, {execute:browser.execute,isWindows:true,launch:async port=>{
    assert.equal(port,'9222');launched = true;browser.makeAvailable();
  },wait:async()=>{},log:()=>{},refresh:async candidate=>candidate});
  assert.equal(launched,true);
});

test('native Linux/macOS fallback opens a headed isolated agent-browser session', async t => {
  const file = await credentialsFile(t), browser = fakeBrowser({available:false});
  await login(file, {execute:browser.execute,isWindows:false,log:()=>{},refresh:async candidate=>candidate});
  assert.ok(browser.calls.some(args=>args.includes('--headed')&&args.includes('new')));
});

test('status exposes expiry metadata without revealing credentials', async t => {
  const file = await credentialsFile(t), status = await new Auth(file).status();
  assert.equal(status.refreshTokenPresent,true);
  assert.equal(status.refreshTokenExpiresAt,'Not exposed by NETGEAR');
  assert.equal(status.importedAt,'2026-01-01T00:00:00.000Z');
  assert.ok(!JSON.stringify(status).includes('working-refresh'));
  assert.ok(!JSON.stringify(status).includes('working-access'));
});

test('access refresh retains unrotated refresh token and metadata without claiming extended validity', async () => {
  const saved={refreshToken:'original-refresh',importedAt:'2026-01-01T00:00:00.000Z'};
  const refreshed=await refreshSession(saved,async()=>({ok:true,json:async()=>({data:{accessToken:'new-access'}})}));
  assert.equal(refreshed.refreshToken,'original-refresh');
  assert.equal(refreshed.importedAt,saved.importedAt);
  assert.equal(refreshed.refreshTokenReplacedAt,undefined);
  assert.ok(refreshed.lastRefreshedAt);
});

test('invalid port and timeout cannot be interpolated into browser launch commands', async t => {
  const file=await credentialsFile(t);
  assert.throws(()=>validatePort('9222;anything'),/port/);
  assert.throws(()=>validatePort('65536'),/port/);
  await assert.rejects(login(file,{timeoutMs:Infinity}),/timeout/);
});
