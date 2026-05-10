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

/** 코어(수비 목표) — 맵 기준 12시 방향(+Z가 아래쪽일 때 북쪽 -Z) */
const CORE_MAX_HP = 100;
const CORE_X = 0;
const CORE_Z = -21;
const CORE_RADIUS = 1.15;
const ENEMY_RADIUS = 0.35;
const ENEMY_MAX_HP = 50;
const BULLET_SPEED = 44;
const BULLET_MAX_RANGE = 40;
/** 탄 충돌 반경 — 클라이언트 총알 크기와 맞추고 너무 넓히지 않음 (근접만으로 맞는 버그 방지) */
const BULLET_RADIUS = 0.14;
/** 한 틱 안에서 탄 이동을 쪼개 적 통과(터널링) 방지 */
const BULLET_PHYS_SUBSTEPS = 12;
const BULLET_DAMAGE = 14;
const SHOOT_COOLDOWN_MS = 220;
const MAX_BULLETS_PER_SESSION = 120;
/** 부동소수점·틱 한계로 코어 바로 앞에서 멈춘 것처럼 보일 때 보정 */
const CORE_HIT_SLACK = 0.06;
const ENEMY_MOVE_DEADLOCK_EPS = 1e-5;
const ENEMY_SPEED = 5.5;
const ENEMY_DAMAGE = 14;
const ENEMY_SPAWN_INTERVAL_MS = 5500;
const MAX_ENEMIES_PER_SESSION = 18;
/** 시뮬 틱 — 탄·충돌 정확도와 보간 주기 (짧을수록 부드럽고 정확) */
const GAME_SIM_MS = 45;
/** 적 생성: 맵 아래쪽(+Z) 가장자리 한 줄, X만 랜덤 */
const SPAWN_EDGE_Z = 23;
const GAME_OVER_RESET_MS = 8000;

const sessions = new Map();

/** 선분(A→B)이 원(cx,cz,r)을 가로지르거나 끝이 원 안인지 — 스텝 사이 통과(터널링) 검출 */
function segmentIntersectsDisc(ax, az, bx, bz, cx, cz, r) {
  const r2 = r * r;
  if ((ax - cx) ** 2 + (az - cz) ** 2 <= r2) return true;
  if ((bx - cx) ** 2 + (bz - cz) ** 2 <= r2) return true;
  const abx = bx - ax;
  const abz = bz - az;
  const acx = cx - ax;
  const acz = cz - az;
  const abLen2 = abx * abx + abz * abz;
  if (abLen2 < 1e-14) return false;
  let t = (acx * abx + acz * abz) / abLen2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + abx * t;
  const qz = az + abz * t;
  const dx = qx - cx;
  const dz = qz - cz;
  return dx * dx + dz * dz <= r2;
}

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
    bullets: {},
    bulletSeq: 0,
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
  session.enemies[id] = {
    id,
    x,
    z,
    y: 0.45,
    hp: ENEMY_MAX_HP,
    maxHp: ENEMY_MAX_HP,
  };
}

function emitSessionWorldState(session) {
  const core = session.core;
  io.to(session.id).emit('world-state', {
    enemies: session.enemies,
    bullets: session.bullets || {},
    core: {
      hp: core.hp,
      maxHp: core.maxHp,
      x: core.x,
      z: core.z,
    },
  });
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
  session.bullets = {};
  session.bulletSeq = 0;
  session.lastEnemySpawnAt = Date.now();
  io.to(session.id).emit('battle-reset', {
    core: session.core,
    enemies: session.enemies,
    bullets: session.bullets,
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

    const bullets = session.bullets || (session.bullets = {});
    const bulletRemove = new Set();
    const hitR = ENEMY_RADIUS + BULLET_RADIUS;
    const subDt = dt / BULLET_PHYS_SUBSTEPS;
    Object.values(bullets).forEach((b) => {
      if (!b || bulletRemove.has(b.id)) return;
      let consumed = false;
      for (let s = 0; s < BULLET_PHYS_SUBSTEPS && !consumed; s += 1) {
        const ox = b.x;
        const oz = b.z;
        b.x += b.vx * subDt;
        b.z += b.vz * subDt;
        b.traveled = (b.traveled || 0) + Math.hypot(b.vx * subDt, b.vz * subDt);
        if (b.traveled > BULLET_MAX_RANGE) {
          bulletRemove.add(b.id);
          consumed = true;
          break;
        }
        Object.values(session.enemies).forEach((e) => {
          if (consumed || !e) return;
          if (segmentIntersectsDisc(ox, oz, b.x, b.z, e.x, e.z, hitR)) {
            consumed = true;
            bulletRemove.add(b.id);
            e.hp = Math.max(0, (typeof e.hp === 'number' ? e.hp : ENEMY_MAX_HP) - BULLET_DAMAGE);
            if (e.hp <= 0) delete session.enemies[e.id];
          }
        });
      }
    });
    bulletRemove.forEach((bid) => {
      delete bullets[bid];
    });

    emitSessionWorldState(session);
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
      bullets: session.bullets || {},
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

  socket.on('shoot', ({ tx, tz } = {}) => {
    const sessionId = socket.data.sessionId;
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session || session.gameOver) return;
    const player = session.players[socket.id];
    if (!player || player.classId !== 'attack') return;
    if (typeof tx !== 'number' || typeof tz !== 'number' || Number.isNaN(tx) || Number.isNaN(tz)) return;

    const now = Date.now();
    const last = socket.data.lastShootAt || 0;
    if (now - last < SHOOT_COOLDOWN_MS) return;
    socket.data.lastShootAt = now;

    const bullets = session.bullets || (session.bullets = {});
    if (Object.keys(bullets).length >= MAX_BULLETS_PER_SESSION) return;

    let dx = tx - player.x;
    let dz = tz - player.z;
    let len = Math.hypot(dx, dz);
    if (len < 0.08) return;
    dx /= len;
    dz /= len;

    const spawnDist = 0.58;
    session.bulletSeq += 1;
    const bid = `b${session.bulletSeq}`;
    bullets[bid] = {
      id: bid,
      x: player.x + dx * spawnDist,
      z: player.z + dz * spawnDist,
      y: 0.38,
      vx: dx * BULLET_SPEED,
      vz: dz * BULLET_SPEED,
      traveled: 0,
    };

    emitSessionWorldState(session);
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
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Multiplay-Game2 → http://localhost:${PORT}/  (bind ${HOST})`);
});
