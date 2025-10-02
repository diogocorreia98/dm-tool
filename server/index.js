const http = require('http');
const WebSocket = require('ws');

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 3001;
const SOCKET_PATH = process.env.SOCKET_PATH || '/ws';

const server = http.createServer();
const wss = new WebSocket.Server({ server, path: SOCKET_PATH });

const sessions = new Map();
let clientCounter = 0;

function log(...args) {
  console.log('[server]', ...args);
}

function createClientId() {
  clientCounter += 1;
  return `c-${Date.now().toString(36)}-${clientCounter.toString(36)}`;
}

function normalizeCode(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toUpperCase();
}

function safeSend(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    console.error('Failed to send payload', error);
    return false;
  }
}

function endSession(session, reason) {
  sessions.delete(session.code);
  session.players.forEach((playerSocket) => {
    safeSend(playerSocket, { type: 'session-closed', message: reason });
    try {
      playerSocket.close();
    } catch (error) {
      console.error('Failed to close player socket', error);
    }
    if (playerSocket.clientInfo) {
      playerSocket.clientInfo = null;
    }
  });
  session.players.clear();
}

function detachClient(socket, options = {}) {
  const info = socket.clientInfo;
  if (!info) {
    return;
  }

  const { reason, silent } = options;

  if (info.role === 'dm') {
    const session = sessions.get(info.code);
    if (session && session.dm === socket) {
      endSession(session, reason || 'The DM disconnected.');
    }
  } else if (info.role === 'player') {
    const session = sessions.get(info.code);
    if (session && session.players.get(info.playerId) === socket) {
      session.players.delete(info.playerId);
      if (session.dm && session.dm.readyState === WebSocket.OPEN) {
        safeSend(session.dm, { type: 'player-left', playerId: info.playerId });
      }
    }
  }

  socket.clientInfo = null;

  if (!silent && socket.readyState === WebSocket.OPEN) {
    try {
      socket.close();
    } catch (error) {
      console.error('Failed to close socket during detach', error);
    }
  }
}

function handleCreateSession(socket, message) {
  const code = normalizeCode(message.code);
  if (!code) {
    safeSend(socket, {
      type: 'session-error',
      message: 'Invalid session code. Refresh the page and try again.',
    });
    return;
  }

  if (socket.clientInfo?.role === 'dm') {
    safeSend(socket, {
      type: 'session-error',
      message: 'You are already hosting a session.',
    });
    return;
  }

  if (sessions.has(code)) {
    safeSend(socket, {
      type: 'session-error',
      message: 'A session with that code already exists.',
    });
    return;
  }

  const session = {
    code,
    dm: socket,
    players: new Map(),
  };

  sessions.set(code, session);
  socket.clientInfo = { role: 'dm', code };
  safeSend(socket, { type: 'session-created', code });
  log('Session created', code);
}

function handleJoinSession(socket, message) {
  const code = normalizeCode(message.code);
  if (!code) {
    safeSend(socket, {
      type: 'session-error',
      message: 'Enter a valid session code from your DM.',
    });
    return;
  }

  const session = sessions.get(code);
  if (!session || session.dm.readyState !== WebSocket.OPEN) {
    safeSend(socket, {
      type: 'session-error',
      message: 'Session not found. Ask your DM for a new code.',
    });
    return;
  }

  if (socket.clientInfo) {
    detachClient(socket, { silent: true });
  }

  const playerId = createClientId();
  session.players.set(playerId, socket);
  socket.clientInfo = { role: 'player', code, playerId };

  safeSend(socket, { type: 'session-joined', code, playerId });
  safeSend(session.dm, { type: 'player-joined', playerId });
  log('Player joined', code, playerId);
}

function relayFromPlayer(socket, message) {
  const info = socket.clientInfo;
  if (!info || info.role !== 'player') {
    return;
  }

  const session = sessions.get(info.code);
  if (!session || session.dm.readyState !== WebSocket.OPEN) {
    safeSend(socket, { type: 'session-closed' });
    detachClient(socket, { reason: 'Session unavailable.' });
    return;
  }

  if (!message || typeof message.payload !== 'object') {
    return;
  }

  safeSend(session.dm, {
    type: 'relay',
    playerId: info.playerId,
    payload: message.payload,
  });
}

function relayFromDm(socket, message) {
  const info = socket.clientInfo;
  if (!info || info.role !== 'dm') {
    return;
  }

  const session = sessions.get(info.code);
  if (!session) {
    return;
  }

  const payload = message.payload;
  if (!payload || typeof payload !== 'object') {
    return;
  }

  if (typeof message.playerId === 'string' && message.playerId) {
    const target = session.players.get(message.playerId);
    if (target) {
      safeSend(target, { type: 'relay', payload });
    }
    return;
  }

  session.players.forEach((playerSocket) => {
    safeSend(playerSocket, { type: 'relay', payload });
  });
}

function handleCloseSession(socket) {
  const info = socket.clientInfo;
  if (!info || info.role !== 'dm') {
    return;
  }

  const session = sessions.get(info.code);
  if (!session || session.dm !== socket) {
    return;
  }

  endSession(session, 'The DM closed the session.');
  socket.clientInfo = null;
  log('Session closed', info.code);
}

wss.on('connection', (socket) => {
  socket.isAlive = true;
  socket.clientInfo = null;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.error('Received invalid JSON payload', error);
      return;
    }

    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'create-session':
        handleCreateSession(socket, message);
        break;
      case 'join-session':
        handleJoinSession(socket, message);
        break;
      case 'relay':
        if (socket.clientInfo?.role === 'dm') {
          relayFromDm(socket, message);
        } else {
          relayFromPlayer(socket, message);
        }
        break;
      case 'close-session':
        handleCloseSession(socket);
        break;
      default:
        break;
    }
  });

  socket.on('close', () => {
    detachClient(socket, { silent: true });
  });

  socket.on('error', (error) => {
    console.error('Socket error', error);
  });
});

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) {
      detachClient(socket, { silent: true, reason: 'Connection timed out.' });
      socket.terminate();
      return;
    }

    socket.isAlive = false;
    try {
      socket.ping();
    } catch (error) {
      console.error('Failed to send ping', error);
    }
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, () => {
  log(`Listening on port ${PORT} (path: ${SOCKET_PATH})`);
});
