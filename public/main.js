import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3d6b4f);

/** 직교 카메라: 값이 작을수록 확대(화면에 가깝게 보임) */
const FRUSTUM_SIZE = 22;
const CAMERA_HEIGHT = 42;
/** 플레이어 추적 시 카메라 중심이 따라붙는 속도 */
const CAMERA_FOLLOW_SMOOTHING = 14;

let aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  (FRUSTUM_SIZE * aspect) / -2,
  (FRUSTUM_SIZE * aspect) / 2,
  FRUSTUM_SIZE / 2,
  FRUSTUM_SIZE / -2,
  0.1,
  200
);

/** 카메라가 바라보는 지면 중심(XZ). 플레이어를 추적한다 */
const cameraFocus = new THREE.Vector3(0, 0, 0);

function applyCameraFromFocus() {
  camera.position.set(cameraFocus.x, CAMERA_HEIGHT, cameraFocus.z);
  camera.lookAt(cameraFocus.x, 0, cameraFocus.z);
}

function snapCameraToLocalPlayer() {
  const local = myId && players[myId];
  if (local) {
    cameraFocus.set(local.mesh.position.x, 0, local.mesh.position.z);
    applyCameraFromFocus();
  }
}

applyCameraFromFocus();

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.left = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const dir = new THREE.DirectionalLight(0xffffff, 0.85);
dir.position.set(10, 30, 8);
scene.add(dir);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(50, 50),
  new THREE.MeshLambertMaterial({ color: 0x7abf7a })
);
ground.rotation.x = -Math.PI / 2;
ground.userData.isGround = true;
scene.add(ground);

const grid = new THREE.GridHelper(50, 50, 0x222222, 0x444444);
grid.position.y = 0.01;
scene.add(grid);

const cubeGeo = new THREE.BoxGeometry(1, 1, 1);
const coreCylinderGeo = new THREE.CylinderGeometry(0.52, 0.62, 1.12, 12);
const coreRingGeo = new THREE.RingGeometry(1.6, 2.35, 48);
const ENEMY_VIS_RADIUS = 0.35;
const enemySphereGeo = new THREE.SphereGeometry(ENEMY_VIS_RADIUS, 14, 14);

const players = {};
const enemyEntities = {};
let coreEntity = null;
let myId = null;
let gameEnded = false;

const MOVE_SPEED = 10;
const BOUND = 24;
const SEND_INTERVAL_MS = 50;

function destroyEntity(entity) {
  if (!entity) return;
  if (entity.label?.element) entity.label.element.remove();
  if (entity.label?.parent) entity.label.parent.remove(entity.label);
  if (entity.mesh?.parent) entity.mesh.parent.remove(entity.mesh);
  if (entity.mesh?.material) entity.mesh.material.dispose();
}

function clearEntityMap(map) {
  Object.keys(map).forEach((id) => {
    destroyEntity(map[id]);
    delete map[id];
  });
}

function destroyEnemyEntry(ent) {
  if (!ent) return;
  if (ent.mesh?.parent) ent.mesh.parent.remove(ent.mesh);
  if (ent.mesh?.material) ent.mesh.material.dispose();
}

function clearAllEnemies() {
  Object.keys(enemyEntities).forEach((id) => {
    destroyEnemyEntry(enemyEntities[id]);
    delete enemyEntities[id];
  });
}

function destroyCoreEntity() {
  if (!coreEntity) return;
  if (coreEntity.ring?.parent) coreEntity.ring.parent.remove(coreEntity.ring);
  if (coreEntity.ring?.material) coreEntity.ring.material.dispose();
  if (coreEntity.label?.element) coreEntity.label.element.remove();
  if (coreEntity.label?.parent) coreEntity.label.parent.remove(coreEntity.label);
  if (coreEntity.mesh?.parent) coreEntity.mesh.parent.remove(coreEntity.mesh);
  if (coreEntity.mesh?.material) coreEntity.mesh.material.dispose();
  coreEntity = null;
}

function updateCoreHud(hp, maxHp) {
  const el = document.getElementById('coreHpText');
  if (!el) return;
  if (typeof hp !== 'number' || typeof maxHp !== 'number') {
    el.textContent = '—';
    return;
  }
  el.textContent = `${hp} / ${maxHp}`;
}

function ensureCore(coreState) {
  if (!coreState || typeof coreState.x !== 'number') return;
  if (!coreEntity) {
    const ring = new THREE.Mesh(
      coreRingGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffe066,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(coreState.x, 0.04, coreState.z);
    ring.renderOrder = 1;
    scene.add(ring);

    const mesh = new THREE.Mesh(
      coreCylinderGeo,
      new THREE.MeshLambertMaterial({
        color: 0xf4d03f,
        emissive: 0x6a4a00,
        emissiveIntensity: 0.45,
      })
    );
    mesh.position.set(coreState.x, coreState.y, coreState.z);
    scene.add(mesh);

    const tagDiv = document.createElement('div');
    tagDiv.className = 'core-name-tag';
    tagDiv.textContent = '코어';
    const label = new CSS2DObject(tagDiv);
    label.position.set(0, 1.35, 0);
    mesh.add(label);

    coreEntity = { mesh, ring, label };
  } else {
    coreEntity.mesh.position.set(coreState.x, coreState.y, coreState.z);
    coreEntity.ring.position.set(coreState.x, 0.04, coreState.z);
  }
  updateCoreHud(coreState.hp, coreState.maxHp);
}

function syncEnemies(next) {
  if (!next || typeof next !== 'object') return;
  const keep = new Set(Object.keys(next));
  Object.keys(enemyEntities).forEach((id) => {
    if (!keep.has(id)) {
      destroyEnemyEntry(enemyEntities[id]);
      delete enemyEntities[id];
    }
  });
  Object.values(next).forEach((e) => {
    if (!e || typeof e.id !== 'string') return;
    const ty = e.y ?? ENEMY_VIS_RADIUS;
    let ent = enemyEntities[e.id];
    if (!ent) {
      const mesh = new THREE.Mesh(
        enemySphereGeo,
        new THREE.MeshLambertMaterial({ color: 0xc0392b })
      );
      mesh.position.set(e.x, ty, e.z);
      scene.add(mesh);
      ent = {
        mesh,
        targetPosition: new THREE.Vector3(e.x, ty, e.z),
      };
      enemyEntities[e.id] = ent;
    } else {
      ent.targetPosition.set(e.x, ty, e.z);
    }
  });
}

function showGameOverUI() {
  document.getElementById('gameOverOverlay')?.classList.remove('hidden');
}

function hideGameOverUI() {
  document.getElementById('gameOverOverlay')?.classList.add('hidden');
}

function createPlayer(p) {
  const existing = players[p.id];
  if (existing) {
    destroyEntity(existing);
    delete players[p.id];
  }

  const mesh = new THREE.Mesh(
    cubeGeo,
    new THREE.MeshLambertMaterial({ color: new THREE.Color(p.color) })
  );
  mesh.position.set(p.x, p.y, p.z);
  mesh.rotation.y = typeof p.ry === 'number' ? p.ry : 0;
  scene.add(mesh);

  const div = document.createElement('div');
  div.className = 'name-tag';
  const nameEl = document.createElement('span');
  nameEl.textContent = p.name;
  div.appendChild(nameEl);
  if (p.classLabel) {
    const classEl = document.createElement('span');
    classEl.className = 'name-tag-class';
    classEl.textContent = p.classLabel;
    div.appendChild(classEl);
  }
  const label = new CSS2DObject(div);
  label.position.set(0, 0.9, 0);
  mesh.add(label);

  players[p.id] = {
    mesh,
    label,
    data: { ...p, ry: typeof p.ry === 'number' ? p.ry : 0 },
    targetPosition: new THREE.Vector3(p.x, p.y, p.z),
  };
}

function removePlayer(id) {
  const p = players[id];
  if (!p) return;
  destroyEntity(p);
  delete players[id];
}

const socket = io({ path: '/multiplay-game2/socket.io' });

const urlParams = new URLSearchParams(window.location.search);
const urlAlpToken = urlParams.get('token');
let joinToken = urlAlpToken || null;
const platformApi = window.__ALP_PLATFORM_API__ || '';

const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const nameInput = document.getElementById('nameInput');
const classSelect = document.getElementById('classSelect');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const playerCountEl = document.getElementById('playerCount');
const roomListEl = document.getElementById('roomList');
const serverCapacityRow = document.getElementById('serverCapacityRow');
const serverCapacityCurrentEl = document.getElementById('serverCapacityCurrent');
const serverCapacityMaxEl = document.getElementById('serverCapacityMax');
const serverCapacityBreakdownEl = document.getElementById('serverCapacityBreakdown');
const authLoading = document.getElementById('authLoading');
const authError = document.getElementById('authError');
const guestFallbackBtn = document.getElementById('guestFallbackBtn');
const alpAccountRow = document.getElementById('alpAccountRow');
const guestNameRow = document.getElementById('guestNameRow');
const alpNicknameEl = document.getElementById('alpNickname');

/** WASD 이동 입력 (월드 XZ: W/S = ±Z, A/D = ±X) */
const keyMove = { w: false, a: false, s: false, d: false };

function isTypingInField(target) {
  if (!target || !target.tagName) return false;
  const t = target.tagName.toLowerCase();
  return t === 'input' || t === 'textarea' || t === 'select';
}

function applyKeyCode(code, down) {
  switch (code) {
    case 'KeyW':
      keyMove.w = down;
      return true;
    case 'KeyA':
      keyMove.a = down;
      return true;
    case 'KeyS':
      keyMove.s = down;
      return true;
    case 'KeyD':
      keyMove.d = down;
      return true;
    default:
      return false;
  }
}

window.addEventListener('keydown', (e) => {
  if (isTypingInField(e.target)) return;
  if (!applyKeyCode(e.code, true)) return;
  if (joined && !gameEnded) e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  applyKeyCode(e.code, false);
});

window.addEventListener('blur', () => {
  keyMove.w = keyMove.a = keyMove.s = keyMove.d = false;
});

let joined = false;
let lobbyJoinAuthBlocked = false;
let lobbyPingIntervalId = null;
let lobbyServerFull = false;
let lastServerCapacity = { current: 0, max: 100, inGame: 0, inLobby: 0 };

function setLobbyAuthBlocked(on) {
  lobbyJoinAuthBlocked = !!on;
  refreshLobbyJoinButton();
}

function stopLobbyPing() {
  if (lobbyPingIntervalId != null) {
    clearInterval(lobbyPingIntervalId);
    lobbyPingIntervalId = null;
  }
}

function startLobbyPing() {
  stopLobbyPing();
  const send = () => {
    if (joined) {
      stopLobbyPing();
      return;
    }
    socket.emit('lobby-ping');
  };
  send();
  lobbyPingIntervalId = setInterval(send, 10_000);
}

function refreshLobbyJoinButton() {
  if (!joinBtn) return;
  const blocked = lobbyJoinAuthBlocked || lobbyServerFull;
  joinBtn.disabled = blocked;
  joinBtn.textContent = lobbyServerFull ? '서버 정원 초과' : '입장';
}

function updateServerCapacityDisplay(payload) {
  const cur = typeof payload.current === 'number' ? payload.current : lastServerCapacity.current;
  const max = typeof payload.max === 'number' ? payload.max : lastServerCapacity.max;
  const inGame = typeof payload.inGame === 'number' ? payload.inGame : lastServerCapacity.inGame;
  const inLobby = typeof payload.inLobby === 'number'
    ? payload.inLobby
    : Math.max(0, cur - inGame);
  lastServerCapacity = { current: cur, max, inGame, inLobby };
  if (serverCapacityMaxEl) serverCapacityMaxEl.textContent = String(max);
  if (serverCapacityCurrentEl) serverCapacityCurrentEl.textContent = String(cur);
  if (serverCapacityBreakdownEl) {
    serverCapacityBreakdownEl.textContent = `게임 중 ${inGame} · 입장 대기 ${inLobby}`;
  }
  lobbyServerFull = cur >= max;
  serverCapacityRow?.classList.toggle('server-full', lobbyServerFull);
  if (!joined) refreshLobbyJoinButton();
}

function renderRoomList(rooms) {
  if (!roomListEl) return;
  roomListEl.innerHTML = '';
  if (!Array.isArray(rooms) || rooms.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'room-item';
    empty.textContent = '아직 활성 방이 없습니다.';
    roomListEl.appendChild(empty);
    return;
  }

  rooms.forEach((room) => {
    const item = document.createElement('div');
    item.className = 'room-item';

    const label = document.createElement('span');
    label.textContent = `${room.id} (${room.players}/4)`;

    const useBtn = document.createElement('button');
    useBtn.textContent = room.players >= 4 ? '가득 참' : '선택';
    useBtn.disabled = room.players >= 4;
    useBtn.addEventListener('click', () => {
      if (roomInput) roomInput.value = room.id;
      roomInput?.focus();
    });

    item.appendChild(label);
    item.appendChild(useBtn);
    roomListEl.appendChild(item);
  });
}

if (roomInput) {
  roomInput.value = urlParams.get('room') || 'lobby';
}

function applyGuestPlayUi() {
  joinToken = null;
  authError?.classList.add('hidden');
  guestFallbackBtn?.classList.add('hidden');
  alpAccountRow?.classList.add('hidden');
  guestNameRow?.classList.remove('hidden');
  if (nameInput) {
    nameInput.readOnly = false;
    nameInput.value = '';
  }
}

function initNoTokenGuestUi() {
  authLoading?.classList.add('hidden');
  authError?.classList.add('hidden');
  guestFallbackBtn?.classList.add('hidden');
  alpAccountRow?.classList.add('hidden');
  guestNameRow?.classList.remove('hidden');
  joinToken = null;
  setLobbyAuthBlocked(false);
}

function initAuthUi() {
  if (!urlAlpToken) {
    initNoTokenGuestUi();
    nameInput?.focus();
    return;
  }

  if (!platformApi) {
    authLoading?.classList.add('hidden');
    if (authError) {
      authError.textContent = '플랫폼 연동 설정이 없어 로그인 확인을 할 수 없습니다. 게스트 닉네임으로 플레이해 주세요.';
      authError.classList.remove('hidden');
    }
    applyGuestPlayUi();
    setLobbyAuthBlocked(false);
    nameInput?.focus();
    return;
  }

  joinToken = urlAlpToken;
  guestNameRow?.classList.add('hidden');
  alpAccountRow?.classList.add('hidden');
  authError?.classList.add('hidden');
  guestFallbackBtn?.classList.add('hidden');
  authLoading?.classList.remove('hidden');
  setLobbyAuthBlocked(true);

  fetch(`${platformApi}/api/auth/me`, {
    headers: { Authorization: `Bearer ${urlAlpToken}` },
  })
    .then((r) => {
      if (!r.ok) throw new Error('verify');
      return r.json();
    })
    .then((data) => {
      const nick = data?.user?.nickname;
      if (!nick) throw new Error('no-nick');
      if (alpNicknameEl) alpNicknameEl.textContent = nick;
      alpAccountRow?.classList.remove('hidden');
      authError?.classList.add('hidden');
      guestFallbackBtn?.classList.add('hidden');
      joinToken = urlAlpToken;
      roomInput?.focus();
    })
    .catch(() => {
      if (authError) {
        authError.textContent = '계정 정보를 불러오지 못했습니다. 입장 시 서버에서 로그인을 다시 확인합니다. 게스트로 플레이하려면 아래 버튼을 누르세요.';
        authError.classList.remove('hidden');
      }
      guestFallbackBtn?.classList.remove('hidden');
      alpAccountRow?.classList.add('hidden');
      guestNameRow?.classList.add('hidden');
      joinToken = urlAlpToken;
    })
    .finally(() => {
      authLoading?.classList.add('hidden');
      setLobbyAuthBlocked(false);
    });
}

guestFallbackBtn?.addEventListener('click', () => {
  applyGuestPlayUi();
  nameInput?.focus();
});

const CLASS_STORAGE_KEY = 'mg2_classId';
const savedClass = sessionStorage.getItem(CLASS_STORAGE_KEY);
if (classSelect && savedClass && [...classSelect.options].some((o) => o.value === savedClass)) {
  classSelect.value = savedClass;
}

function selectedClassId() {
  return classSelect?.value || 'attack';
}

function join() {
  if (joined) return;
  const sessionId = roomInput?.value.trim() || 'lobby';
  const classId = selectedClassId();

  if (joinToken) {
    socket.emit('join', { name: '', sessionId, token: joinToken, classId });
    return;
  }

  const name = nameInput?.value.trim() || '';
  if (!name) {
    alert('닉네임을 입력해 주세요.');
    nameInput?.focus();
    return;
  }
  socket.emit('join', { name, sessionId, classId });
}

joinBtn.addEventListener('click', join);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});
roomInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});

initAuthUi();

socket.on('connect', () => {
  if (!joined) startLobbyPing();
});
if (socket.connected) {
  startLobbyPing();
}

socket.on('server-capacity', (payload) => {
  if (!payload || typeof payload !== 'object') return;
  updateServerCapacityDisplay(payload);
});

socket.on('room-list', (rooms) => {
  if (joined) return;
  renderRoomList(rooms);
});

socket.on('join-error', ({ message }) => {
  joined = false;
  hideGameOverUI();
  alert(message || '방 입장에 실패했습니다.');
  if (message && /로그인|세션|만료|ALP/i.test(message) && urlAlpToken) {
    applyGuestPlayUi();
    setLobbyAuthBlocked(false);
    nameInput?.focus();
  }
});

socket.on('init', ({ id, players: list, core, enemies, gameOver }) => {
  joined = true;
  stopLobbyPing();
  sessionStorage.setItem(CLASS_STORAGE_KEY, selectedClassId());
  overlay.classList.add('hidden');
  hud.classList.remove('hidden');
  clearEntityMap(players);
  clearAllEnemies();
  destroyCoreEntity();
  gameEnded = !!gameOver;
  myId = id;
  Object.values(list).forEach(createPlayer);
  if (core) ensureCore(core);
  if (enemies) syncEnemies(enemies);
  if (gameEnded) showGameOverUI();
  else hideGameOverUI();
  snapCameraToLocalPlayer();
});

socket.on('world-state', ({ enemies, core }) => {
  if (!joined || gameEnded) return;
  if (core && typeof core.hp === 'number') updateCoreHud(core.hp, core.maxHp);
  if (enemies) syncEnemies(enemies);
});

socket.on('core-update', ({ hp, maxHp }) => {
  if (!joined) return;
  updateCoreHud(hp, maxHp);
});

socket.on('game-over', () => {
  gameEnded = true;
  keyMove.w = keyMove.a = keyMove.s = keyMove.d = false;
  showGameOverUI();
});

socket.on('battle-reset', ({ core, enemies }) => {
  gameEnded = false;
  hideGameOverUI();
  clearAllEnemies();
  destroyCoreEntity();
  if (core) ensureCore(core);
  syncEnemies(enemies || {});
  snapCameraToLocalPlayer();
});

socket.on('player-joined', createPlayer);
socket.on('player-left', removePlayer);

socket.on('player-moved', ({ id, x, y, z, ry }) => {
  const p = players[id];
  if (!p || id === myId) return;
  p.targetPosition.set(x, y, z);
  if (typeof ry === 'number') {
    p.data.ry = ry;
    p.mesh.rotation.y = ry;
  }
});

window.addEventListener('resize', () => {
  aspect = window.innerWidth / window.innerHeight;
  camera.left = (FRUSTUM_SIZE * aspect) / -2;
  camera.right = (FRUSTUM_SIZE * aspect) / 2;
  camera.top = FRUSTUM_SIZE / 2;
  camera.bottom = FRUSTUM_SIZE / -2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

let lastTime = performance.now();
let lastSent = 0;
const REMOTE_SMOOTHING = 14;
/** 서버 틱 사이 보간 — 적 구체가 덜 덜덜 끊기게 */
const ENEMY_SMOOTHING = 26;

function emitMyPosition(me) {
  const pos = me.mesh.position;
  socket.emit('move', {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    ry: me.data.ry,
  });
  lastSent = performance.now();
}

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  const remoteAlpha = 1 - Math.exp(-REMOTE_SMOOTHING * dt);
  const enemyAlpha = 1 - Math.exp(-ENEMY_SMOOTHING * dt);
  const camAlpha = 1 - Math.exp(-CAMERA_FOLLOW_SMOOTHING * dt);

  Object.values(enemyEntities).forEach((ent) => {
    ent.mesh.position.lerp(ent.targetPosition, enemyAlpha);
  });

  const me = players[myId];
  if (joined && me) {
    const px = me.mesh.position.x;
    const pz = me.mesh.position.z;
    cameraFocus.x += (px - cameraFocus.x) * camAlpha;
    cameraFocus.z += (pz - cameraFocus.z) * camAlpha;
  } else {
    cameraFocus.x += (0 - cameraFocus.x) * camAlpha;
    cameraFocus.z += (0 - cameraFocus.z) * camAlpha;
  }
  applyCameraFromFocus();

  const meForMove = players[myId];
  if (joined && meForMove && !gameEnded) {
    let vx = 0;
    let vz = 0;
    if (keyMove.w) vz -= 1;
    if (keyMove.s) vz += 1;
    if (keyMove.a) vx -= 1;
    if (keyMove.d) vx += 1;
    const len = Math.hypot(vx, vz);
    const pos = meForMove.mesh.position;
    pos.y = 0.5;
    if (len > 1e-6) {
      vx /= len;
      vz /= len;
      pos.x += vx * MOVE_SPEED * dt;
      pos.z += vz * MOVE_SPEED * dt;
      pos.x = Math.max(-BOUND, Math.min(BOUND, pos.x));
      pos.z = Math.max(-BOUND, Math.min(BOUND, pos.z));
      const ry = Math.atan2(vx, vz);
      meForMove.mesh.rotation.y = ry;
      meForMove.data.ry = ry;
      if (now - lastSent > SEND_INTERVAL_MS) {
        emitMyPosition(meForMove);
      }
    }
  }

  Object.keys(players).forEach((id) => {
    if (id === myId) return;
    const p = players[id];
    p.mesh.position.lerp(p.targetPosition, remoteAlpha);
  });

  playerCountEl.textContent = `Players: ${Object.keys(players).length}`;
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}

animate();
