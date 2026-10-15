const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const { browserJSON, SESSION_EXPRESSION, validatePort, CLIENT_ID, refreshSession } = require('./auth');
const { readJSON, writeJSON } = require('./store');

const LOGIN_URL = `https://accounts2.netgear.com/login/meural?redirectUrl=${encodeURIComponent('https://my.meural.netgear.com/')}&clientId=${CLIENT_ID}`;

function launchWindowsChrome(port) {
  validatePort(port);
  // Same Windows profile and launch flags as the user's cdp-chrome helper.
  const script = `$ErrorActionPreference='Stop'
    $meuralChrome=Join-Path $env:ProgramFiles 'Google\\Chrome\\Application\\chrome.exe'
    $meuralProfile=Join-Path $env:LOCALAPPDATA 'agent-browser\\chrome-cdp-profile-${Number(port)}'
    Start-Process -FilePath $meuralChrome -ArgumentList @('--remote-debugging-port=${Number(port)}', ('--user-data-dir="{0}"' -f $meuralProfile), '--no-first-run')`;
  try {
    execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { throw new Error('Could not start Windows Chrome. Run cdp-chrome in your WSL terminal, then retry node index.js login.'); }
}

async function login(file, options = {}) {
  const { port = '9222', timeoutMs = 600000, pollMs = 2000, execute = browserJSON,
    launch = launchWindowsChrome, wait = sleep, log = console.log,
    isWindows = process.platform === 'win32' || /microsoft/i.test(os.release()),
    refresh = refreshSession } = options;
  validatePort(port);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 1800000) throw new Error('Login timeout must be between 1 and 1800 seconds.');
  let previous;
  try { previous = await readJSON(file); } catch { /* Login can repair a missing/corrupt credentials file. */ }
  let prefix = ['--cdp', String(port), '--json'];
  const browser = (...args) => execute([...prefix, ...args]);
  try { await browser('tab'); }
  catch {
    if (isWindows) {
      await launch(port);
      let connected = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await wait(500);
        try { await browser('tab'); connected = true; break; } catch { /* Chrome is starting. */ }
      }
      if (!connected) throw new Error('Chrome started but CDP is unreachable. Check port ' + port + ' and retry node index.js login.');
    } else {
      // Native Linux/macOS: agent-browser launches its own visible Chrome.
      prefix = ['--session', 'meural-login', '--headed', '--json'];
    }
  }
  let existing = false;
  try { await browser('tab', 'meural-login'); existing = true; } catch { /* First login tab. */ }
  if (existing) await browser('open', LOGIN_URL);
  else await browser('tab', 'new', '--label', 'meural-login', LOGIN_URL);
  log('Complete NETGEAR sign-in and any verification code in the browser.');
  log('Waiting for the redirect back to Meural; passwords and tokens will not be printed.');
  const deadline = Date.now() + timeoutMs;
  let warnedAboutPreviousSession = false;
  do {
    let session;
    try {
      await browser('tab', 'meural-login');
      session = (await browser('eval', SESSION_EXPRESSION)).result;
    }
    catch { /* Navigation can temporarily destroy the page execution context. */ }
    if (session?.ready && session.accessToken && session.refreshToken) {
      if (session.refreshToken === previous?.refreshToken) {
        if (!warnedAboutPreviousSession) {
          log('The browser still has the previous session. Finish sign-in; if NETGEAR reuses it, sign out in the login tab and sign in again.');
          warnedAboutPreviousSession = true;
        }
        await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      const candidate = { accessToken: session.accessToken, refreshToken: session.refreshToken,
        clientId: CLIENT_ID, importedAt: new Date().toISOString() };
      // Verify the new refresh token BEFORE replacing the saved working session.
      const verified = await refresh(candidate);
      await writeJSON(file, verified);
      log('Login complete. Saved and verified the refresh token; weekly runs do not need Chrome.');
      return;
    }
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('Login timed out. Existing saved credentials were kept. Run node index.js login to try again.');
}

module.exports = { login, launchWindowsChrome, LOGIN_URL };
