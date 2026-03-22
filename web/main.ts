import { getWebSocket } from './websocket-client';

main();
function main() {
  const websocket = getWebSocket();
  console.log(websocket);
}
// ── Receive events pushed from Bare ──────────────────────────
window.onBareEvent = async function (data) {
  let jsonStr = data;
  if (data instanceof Blob) {
    jsonStr = await data.text();
  } else if (data && typeof data === 'object' && data.data !== undefined) {
    jsonStr = data.data;
  }

  // If we already have an object (from Vite HMR bridge), don't re-parse
  if (typeof jsonStr === 'object' && jsonStr !== null) {
    handleEvent(jsonStr);
    return;
  }

  try {
    const event = JSON.parse(jsonStr);
    handleEvent(event);
  } catch (e) {
    log('error', 'Failed to parse event: ' + jsonStr);
  }
};

function handleEvent(event) {
  switch (event.type) {
    case 'swarm:status':
      log('status', event.data.status);
      break;
    case 'swarm:peer':
      log('peer', event.data.peer);
      break;
    case 'swarm:data':
      log('recv', `${event.data.peer}: ${event.data.data}`);
      break;
    default:
      log(event.type, event.data);
  }
}

// ── Dev Bridge Polyfill (HMR) ─────────────────────────────────
let nextRequestId = 0;
if (import.meta.hot) {
  // Polyfill NativeBridge for development using Vite's HMR
  window.NativeBridge = {
    send: (payload) => {
      import.meta.hot.send('bare:request', { id: nextRequestId++, payload });
    },
  };

  import.meta.hot.on('bare:reply', (data) => {
    if (data.error) {
      log('error', 'Bare reply error: ' + data.error);
    } else if (data.result) {
      window.onBareEvent(data.result);
    }
  });

  import.meta.hot.on('bare:event', (data) => {
    if (data.result) {
      window.onBareEvent(data.result);
    }
  });

  console.log('✅ Vite HMR Bridge active (NativeBridge polyfilled)');
}

// ── Send commands to Bare ─────────────────────────────────────
function sendToBare(cmd, data) {
  const payload = JSON.stringify({ cmd, data });

  if (window.NativeBridge) {
    window.NativeBridge.send(payload);
  } else {
    log('error', 'NativeBridge not found. If in dev, ensure Vite is running.');
  }
}

// ── Example actions ───────────────────────────────────────────
function joinSwarm() {
  const topic = document.getElementById('topic').value.trim();
  if (!topic) {
    log('error', 'Topic is required');
    return;
  }

  log('info', 'Joining swarm...');
  sendToBare('swarm:join', { topic });
}

function sendMessage() {
  const msg = document.getElementById('message').value.trim();
  if (!msg) return;

  sendToBare('swarm:send', { message: msg });
  log('send', msg);
  document.getElementById('message').value = '';
}

function log(label, data) {
  const msg =
    label + ': ' + (typeof data === 'string' ? data : JSON.stringify(data));
  const logEl = document.getElementById('log');
  if (logEl) {
    logEl.textContent += msg + '\n';
  }
  console.log(msg);
}

// Attach event listeners
const joinBtn = document.getElementById('joinBtn');
if (joinBtn) joinBtn.addEventListener('click', joinSwarm);

const sendBtn = document.getElementById('sendBtn');
if (sendBtn) sendBtn.addEventListener('click', sendMessage);
