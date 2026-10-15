const readline = require('node:readline');

async function prompt(label, { secret = false, input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    if (label.includes('code')) throw new Error('NETGEAR requires a verification code. Run node index.js login in an interactive terminal to enter it. Existing saved credentials were kept.');
    throw new Error('Interactive input is required. Configure NETGEAR_EMAIL and NETGEAR_PASSWORD in .env, or run login in a terminal to enter credentials and verification codes.');
  }
  if (!secret) {
    const rl = readline.createInterface({ input, output });
    try {
      return await new Promise((resolve, reject) => {
        rl.once('SIGINT', () => reject(new Error('Login cancelled.')));
        rl.once('close', () => reject(new Error('Login cancelled.')));
        rl.question(label, resolve);
      });
    } finally { rl.close(); }
  }
  // No echo and no asterisks: neither password text nor its length is displayed.
  readline.emitKeypressEvents(input);
  const wasRaw = input.isRaw, wasFlowing = input.readableFlowing;
  output.write(label);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.setRawMode(!!wasRaw);
      // Untouched stdin has readableFlowing === null, but isPaused() is false.
      // Pause it too, otherwise the read handle keeps the process alive.
      if (wasFlowing !== true) input.pause();
      output.write('\n');
    };
    const onEnd = () => { cleanup(); reject(new Error('Login cancelled.')); };
    const onKey = (text, key = {}) => {
      if (key.ctrl && ['c','d'].includes(key.name)) return onEnd();
      if (['return','enter'].includes(key.name)) { cleanup(); resolve(value); return; }
      if (key.name === 'backspace') { value = [...value].slice(0, -1).join(''); return; }
      if (!key.ctrl && !key.meta && text && !text.includes('\x1b')) value += text.replace(/[\r\n\x00]/g, '');
    };
    input.on('keypress', onKey);
    input.once('end', onEnd);
  });
}

module.exports = { prompt };
