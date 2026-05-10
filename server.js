const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PLATFORM_API_URL = process.env.PLATFORM_API_URL || 'http://43.203.215.179:4000';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.__ALP_PLATFORM_API__ = ${JSON.stringify(PLATFORM_API_URL)};`);
});

app.get('/status', (req, res) => {
  const inGame = countTotalPlayers();
  const totalConnections = io.sockets.sockets.size;
  res.json({
    totalPlayers: inGame,
    totalConnections,
    inLobby: Math.max(0, totalConnections - inGame),
    totalRooms: sessions.size,
    maxTotalPlayers: MAX_TOTAL_PLAYERS,
  });
});

async function verifyTokenWithPlatform(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${PLATFORM_API_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user || null;
  } catch (err) {
    console.error('[token-verify] error', err.message);
    return null;
  }
}

const server = http.createServer(app);
const io = new Server(server, { path: '/multiplay-game2/socket.io' });

const SESSION_ID_MAX_LEN = 30;
const MAX_PLAYERS_PER_SESSION = 4;
const MAX_TOTAL_PLAYERS = 100;
const IDLE_TIMEOUT_MS = 30_000;
const TICK_MS = 1000;

/** 코어(수비 목표) — 맵 남서쪽 구석 */
const CORE_MAX_HP = 100;
const CORE_X = -21;
const CORE_Z = -21;
const CORE_RADIUS = 1.15;
const ENEMY_RADIUS = 0.35;
/** 부동소수점·틱 한계로 코어 바로 앞에서 멈춘 것처럼 보일 때 보정 */
const CORE_HIT_SLACK = 0.06;
const ENEMY_MOVE_DEADLOCK_EPS = 1e-5;
const ENEMY_SPEED = 5.5;
const ENEMY_DAMAGE = 14;
const ENEMY_SPAWN_INTERVAL_MS = 5500;
const MAX_ENEMIES_PER_SESSION = 18;
/** 짧은 틱 + 클라 보조 보간으로 부드러운 이동 */
const GAME_SIM_MS = 75;
/** 적 생성: 맵 아래쪽(+Z) 가장자리 한 줄, X만 랜덤 */
const SPAWN_EDGE_Z = 23;
const GAME_OVER_RESET_MS = 8000;

const sessions = new Map();

function countTotalPlayers() {
  let n = 0;
  sessions.forEach((session) => {
    n += Object.keys(session.players).length;
  });
  return n;
}

const PLAYER_CLASSES = {
  attack: { label: '공격', color: '#c0392b' },
  defense: { label: '방어', color: '#2980b9' },
};

const DEFAULT_CLASS_ID = 'attack';

function resolvePlayerClass(rawClassId) {
  const id = rawClassId != null ? String(rawClassId).trim() : '';
  if (id && PLAYER_CLASSES[id]) {
    const def = PLAYER_CLASSES[id];
    return { id, label: def.label, color: def.color };
  }
  const def = PLAYER_CLASSES[DEFAULT_CLASS_ID];
  return { id: DEFAULT_CLASS_ID, label: def.label, color: def.color };
}

function spawnPosition() {
  return {
    x: (Math.random() - 0.5) * 10,
    y: 0.5,
    z: (Math.random() - 0.5) * 10,
  };
}

function sanitizeSessionId(rawSessionId) {
  const sessionId = (rawSessionId || 'lobby').toString().trim().slice(0, SESSION_ID_MAX_LEN);
  return sessionId || 'lobby';
}

function normalizeNickname(name) {
  return (name || '').toString().trim().toLowerCase();
}

function createCoreState() {
  return {
    x: CORE_X,
    y: 0.65,
    z: CORE_Z,
    hp: CORE_MAX_HP,
    maxHp: CORE_MAX_HP,
    destroyed: false,
  };
}

function createEmptySession(id) {
  return {
    id,
    players: {},
    core: createCoreState(),
    enemies: {},
    enemySeq: 0,
    gameOver: false,
    lastEnemySpawnAt: Date.now(),
    gameOverResetTimer: null,
  };
}

function spawnEnemy(session) {
  if (Object.keys(session.enemies).length >= MAX_ENEMIES_PER_SESSION) return;
  const B = SPAWN_EDGE_Z;
  const x = (Math.random() * 2 - 1) * B;
  const z = B;
  session.enemySeq += 1;
  const id = `e${session.enemySeq}`;
  session.enemies[id] = { id, x, z, y: 0.45 };
}

function resetSessionBattle(session) {
  if (!session) return;
  if (session.gameOverResetTimer) {
    clearTimeout(session.gameOverResetTimer);
    session.gameOverResetTimer = null;
  }
  session.gameOver = false;
  session.core = createCoreState();
  session.enemies = {};
  session.enemySeq = 0;
  session.lastEnemySpawnAt = Date.now();
  io.to(session.id).emit('battle-reset', {
    core: session.core,
    enemies: session.enemies,
  });
}

function scheduleBattleReset(session) {
  if (session.gameOverResetTimer) clearTimeout(session.gameOverResetTimer);
  const sid = session.id;
  session.gameOverResetTimer = setTimeout(() => {
    session.gameOverResetTimer = null;
    const s = sessions.get(sid);
    if (!s) return;
    resetSessionBattle(s);
  }, GAME_OVER_RESET_MS);
}

function emitGameOver(session, reason) {
  io.to(session.id).emit('game-over', { reason });
  scheduleBattleReset(session);
}

function getOrCreateSession(sessionId) {
  const normalizedId = sanitizeSessionId(sessionId);
  if (!sessions.has(normalizedId)) {
    sessions.set(normalizedId, createEmptySession(normalizedId));
  }
  return sessions.get(normalizedId);
}

function getRoomListPayload() {
  return Array.from(sessions.values())
    .map((session) => ({
      id: session.id,
      players: Object.keys(session.players).length,
      wave: 0,
    }))
    .sort((a, b) => b.players - a.players || a.id.localeCompare(b.id));
}

function broadcastRoomList() {
  io.emit('room-list', getRoomListPayload());
}

function getServerCapacityPayload() {
  const total = io.sockets.sockets.size;
  const inGame = countTotalPlayers();
  const inLobby = Math.max(0, total - inGame);
  return {
    current: total,
    inGame,
    inLobby,
    max: MAX_TOTAL_PLAYERS,
  };
}

function broadcastServerCapacity() {
  io.emit('server-capacity', getServerCapacityPayload());
}

function broadcastLobbyMeta() {
  broadcastRoomList();
  broadcastServerCapacity();
}

function removePlayerFromSession(session, playerId) {
  if (!session?.players?.[playerId]) return false;
  delete session.players[playerId];
  io.to(session.id).emit('player-left', playerId);
  if (Object.keys(session.players).length === 0) {
    if (session.gameOverResetTimer) {
      clearTimeout(session.gameOverResetTimer);
      session.gameOverResetTimer = null;
    }
    sessions.delete(session.id);
  }
  return true;
}

setInterval(() => {
  const now = Date.now();
  let lobbyKicked = false;
  io.sockets.sockets.forEach((sock) => {
    if (sock.data.sessionId) return;
    const lastLobby = sock.data.lastLobbyActivityAt || 0;
    if (now - lastLobby < IDLE_TIMEOUT_MS) return;
    sock.emit('join-error', { message: '입장 화면에서 30초 동안 응답이 없어 연결이 종료되었습니다.' });
    sock.disconnect(true);
    lobbyKicked = true;
  });
  if (lobbyKicked) {
    broadcastServerCapacity();
  }

  let roomListDirty = false;
  sessions.forEach((session) => {
    Object.keys(session.players).forEach((playerId) => {
      const player = session.players[playerId];
      if (!player) return;
      if (now - (player.lastActiveAt || 0) < IDLE_TIMEOUT_MS) return;
      if (!removePlayerFromSession(session, playerId)) return;
      roomListDirty = true;
      const idleSocket = io.sockets.sockets.get(playerId);
      if (idleSocket) {
        idleSocket.emit('join-error', { message: '30초 동안 동작이 없어 방에서 퇴장되었습니다.' });
        idleSocket.data.sessionId = undefined;
        idleSocket.disconnect(true);
      }
    });
  });
  if (roomListDirty) {
    broadcastLobbyMeta();
  }
}, TICK_MS);

setInterval(() => {
  const dt = GAME_SIM_MS / 1000;
  const now = Date.now();
  sessions.forEach((session) => {
    if (session.gameOver) return;
    if (!session.core || session.core.hp <= 0) return;
    if (Object.keys(session.players).length === 0) return;

    const core = session.core;

    if (!session.lastEnemySpawnAt) session.lastEnemySpawnAt = now;
    if (now - session.lastEnemySpawnAt >= ENEMY_SPAWN_INTERVAL_MS) {
      session.lastEnemySpawnAt = now;
      spawnEnemy(session);
    }

    const hitIds = [];
    Object.values(session.enemies).forEach((e) => {
      const dx = core.x - e.x;
      const dz = core.z - e.z;
      const dist = Math.hypot(dx, dz);
      const reach = CORE_RADIUS + ENEMY_RADIUS;
      if (dist <= reach + CORE_HIT_SLACK) {
        hitIds.push(e.id);
        return;
      }
      const step = ENEMY_SPEED * dt;
      const nx = dx / dist;
      const nz = dz / dist;
      let move = Math.min(step, Math.max(0, dist - reach));
      if (move < ENEMY_MOVE_DEADLOCK_EPS) {
        hitIds.push(e.id);
        return;
      }
      e.x += nx * move;
      e.z += nz * move;
    });

    if (hitIds.length > 0) {
      const dmg = hitIds.length * ENEMY_DAMAGE;
      core.hp = Math.max(0, core.hp - dmg);
      hitIds.forEach((hid) => {
        delete session.enemies[hid];
      });
      io.to(session.id).emit('core-update', { hp: core.hp, maxHp: core.maxHp });
      if (core.hp <= 0) {
        core.destroyed = true;
        session.gameOver = true;
        emitGameOver(session, 'core-destroyed');
      }
    }

    io.to(session.id).emit('world-state', {
      enemies: session.enemies,
      core: {
        hp: core.hp,
        maxHp: core.maxHp,
        x: core.x,
        z: core.z,
      },
    });
  });
}, GAME_SIM_MS);

io.on('connection', (socket) => {
  if (io.sockets.sockets.size > MAX_TOTAL_PLAYERS) {
    socket.emit('join-error', {
      message: `서버 접속 인원이 가득 찼습니다. (최대 ${MAX_TOTAL_PLAYERS}명, 입장 대기 포함)`,
    });
    socket.disconnect(true);
    broadcastServerCapacity();
    return;
  }

  socket.data.lastLobbyActivityAt = Date.now();

  socket.on('lobby-ping', () => {
    if (socket.data.sessionId) return;
    socket.data.lastLobbyActivityAt = Date.now();
  });

  socket.emit('room-list', getRoomListPayload());
  socket.emit('server-capacity', getServerCapacityPayload());
  broadcastServerCapacity();

  socket.on('join', async ({ name: rawName, sessionId: rawSessionId, token, classId: rawClassId } = {}) => {
    socket.data.lastLobbyActivityAt = Date.now();
    const sessionId = sanitizeSessionId(rawSessionId);
    const session = getOrCreateSession(sessionId);
    if (session.players[socket.id]) return;
    if (Object.keys(session.players).length >= MAX_PLAYERS_PER_SESSION) {
      socket.emit('join-error', { message: `방 정원은 최대 ${MAX_PLAYERS_PER_SESSION}명입니다.` });
      return;
    }

    if (countTotalPlayers() >= MAX_TOTAL_PLAYERS) {
      socket.emit('join-error', {
        message: `게임 입장 인원이 가득 찼습니다. (최대 ${MAX_TOTAL_PLAYERS}명, 입장 대기·게임 중 합산 접속 기준)`,
      });
      return;
    }

    const clientNick = (rawName || '').toString().trim().slice(0, 20);
    let name;
    let alpUserId = null;
    if (token) {
      const verified = await verifyTokenWithPlatform(token);
      if (!verified) {
        socket.emit('join-error', { message: 'ALP 로그인 세션이 만료되었습니다. 플랫폼에서 다시 로그인해주세요.' });
        return;
      }
      const platformNick =
        verified.nickname != null && String(verified.nickname).trim() !== ''
          ? String(verified.nickname).trim().slice(0, 20)
          : '';
      name = platformNick || clientNick || 'Player';
      alpUserId = verified.id;
    } else {
      name = clientNick || 'Player';
    }

    const normalizedName = normalizeNickname(name);
    const hasDuplicateName = Object.values(session.players).some(
      (player) => normalizeNickname(player.name) === normalizedName
    );
    if (hasDuplicateName) {
      socket.emit('join-error', { message: '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.' });
      return;
    }

    if (countTotalPlayers() >= MAX_TOTAL_PLAYERS) {
      socket.emit('join-error', {
        message: `게임 입장 인원이 가득 찼습니다. (최대 ${MAX_TOTAL_PLAYERS}명, 입장 대기·게임 중 합산 접속 기준)`,
      });
      return;
    }

    const cls = resolvePlayerClass(rawClassId);
    const pos = spawnPosition();
    session.players[socket.id] = {
      id: socket.id,
      name,
      alpUserId,
      classId: cls.id,
      classLabel: cls.label,
      color: cls.color,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      ry: 0,
      alive: true,
      lastActiveAt: Date.now(),
    };

    socket.data.sessionId = sessionId;
    socket.join(sessionId);

    socket.emit('init', {
      id: socket.id,
      players: session.players,
      enemies: session.enemies,
      core: session.core,
      gameOver: session.gameOver,
      wave: 0,
    });
    socket.to(sessionId).emit('player-joined', session.players[socket.id]);
    broadcastLobbyMeta();
  });

  socket.on('move', (pos) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const p = session.players[socket.id];
    if (!p || !pos) return;
    if (typeof pos.x !== 'number' || typeof pos.z !== 'number') return;
    if (typeof pos.y !== 'number') return;
    if (pos.ry !== undefined && typeof pos.ry !== 'number') return;
    p.x = pos.x;
    p.y = pos.y;
    p.z = pos.z;
    if (typeof pos.ry === 'number') p.ry = pos.ry;
    p.lastActiveAt = Date.now();
    socket.to(sessionId).emit('player-moved', {
      id: socket.id,
      x: p.x,
      y: p.y,
      z: p.z,
      ry: p.ry,
    });
  });

  socket.on('disconnect', () => {
    const sessionId = socket.data.sessionId;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (session && removePlayerFromSession(session, socket.id)) {
        broadcastLobbyMeta();
        return;
      }
    }
    broadcastServerCapacity();
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`Multiplay-Game2 running on http://localhost:${PORT}`);
});
