import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static('public'));

const rooms = new Map();
const clients = new Map();

const MAX_PLAYERS = 2;
const ROUND_END_MS = 2200;
const ROUND_COUNTDOWN_MS = 3200;
const BODY_DAMAGE = 34;
const HEAD_DAMAGE = 100;
const MAX_ROOM_AGE_MS = 12 * 60 * 60 * 1000;

// The outdoor industrial map runs from approximately z=34 to z=-70.
const SPAWNS = [
  { x: -7.5, y: 1.72, z: 29, yaw: 0 },
  { x: 7.5, y: 1.72, z: -63, yaw: Math.PI }
];

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    clients: wss.clients.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';

    for (let index = 0; index < 5; index++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    if (!rooms.has(code)) {
      return code;
    }
  }

  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function safeSend(socket, payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, exceptId = null) {
  for (const [playerId, player] of room.players) {
    if (playerId === exceptId) {
      continue;
    }

    safeSend(player.ws, payload);
  }
}

function serializePlayer(player) {
  return {
    id: player.id,
    slot: player.slot,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    aiming: player.aiming,
    crouched: player.crouched,
    sprinting: player.sprinting,
    moving: player.moving,
    velocityX: player.velocityX,
    velocityZ: player.velocityZ,
    hp: player.hp,
    score: player.score,
    alive: player.alive,
    ready: player.ready
  };
}

function getFreeSlot(room) {
  const used = new Set(
    [...room.players.values()].map(player => player.slot)
  );

  for (let slot = 0; slot < MAX_PLAYERS; slot++) {
    if (!used.has(slot)) {
      return slot;
    }
  }

  return -1;
}

function resetPlayer(player) {
  const spawn = SPAWNS[player.slot];

  player.x = spawn.x;
  player.y = spawn.y;
  player.z = spawn.z;
  player.yaw = spawn.yaw;
  player.pitch = 0;
  player.aiming = false;
  player.crouched = false;
  player.sprinting = false;
  player.moving = false;
  player.velocityX = 0;
  player.velocityZ = 0;
  player.hp = 100;
  player.alive = true;
  player.lastShotAt = 0;
}

function createPlayer(ws, slot, name = 'Operator') {
  const player = {
    id: makeId(),
    ws,
    slot,
    name: String(name || 'Operator').trim().slice(0, 18) || 'Operator',
    x: 0,
    y: 1.72,
    z: 0,
    yaw: 0,
    pitch: 0,
    aiming: false,
    crouched: false,
    sprinting: false,
    moving: false,
    velocityX: 0,
    velocityZ: 0,
    hp: 100,
    score: 0,
    alive: true,
    ready: false,
    lastStateAt: 0,
    lastShotAt: 0,
    lastSeenAt: Date.now()
  };

  resetPlayer(player);
  return player;
}

function clearRoomTimer(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
}

function createRoom() {
  const code = makeRoomCode();

  const room = {
    code,
    players: new Map(),
    createdAt: Date.now(),
    round: 0,
    phase: 'waiting',
    startedAt: 0,
    roundTimer: null
  };

  rooms.set(code, room);
  return room;
}

function startRound(room, reason = 'nextRound') {
  if (!room || room.players.size !== MAX_PLAYERS) {
    return;
  }

  clearRoomTimer(room);

  room.round += 1;
  room.phase = 'countdown';
  room.startedAt = Date.now() + ROUND_COUNTDOWN_MS;

  for (const player of room.players.values()) {
    resetPlayer(player);
  }

  broadcast(room, {
    type: 'roundReset',
    round: room.round,
    startAt: room.startedAt,
    reason,
    players: [...room.players.values()].map(serializePlayer)
  });

  room.roundTimer = setTimeout(() => {
    const liveRoom = rooms.get(room.code);

    if (!liveRoom || liveRoom.players.size !== MAX_PLAYERS) {
      return;
    }

    liveRoom.phase = 'live';
    liveRoom.startedAt = Date.now();

    broadcast(liveRoom, {
      type: 'roundLive',
      round: liveRoom.round,
      startedAt: liveRoom.startedAt
    });
  }, ROUND_COUNTDOWN_MS);
}

function endRound(room, killer, victim) {
  if (!room || room.phase !== 'live') {
    return;
  }

  room.phase = 'roundEnd';
  victim.alive = false;
  victim.hp = 0;
  killer.score += 1;

  broadcast(room, {
    type: 'roundEnd',
    round: room.round,
    winnerId: killer.id,
    loserId: victim.id,
    winnerScore: killer.score,
    nextRoundIn: ROUND_END_MS,
    players: [...room.players.values()].map(serializePlayer)
  });

  clearRoomTimer(room);

  room.roundTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (!currentRoom || currentRoom.players.size !== MAX_PLAYERS) {
      return;
    }

    startRound(currentRoom, 'elimination');
  }, ROUND_END_MS);
}

function joinRoom(ws, roomCode, name) {
  const room = rooms.get(roomCode);

  if (!room) {
    safeSend(ws, { type: 'error', message: 'ROOM_NOT_FOUND' });
    return;
  }

  if (room.players.size >= MAX_PLAYERS) {
    safeSend(ws, { type: 'error', message: 'ROOM_FULL' });
    return;
  }

  const slot = getFreeSlot(room);
  const player = createPlayer(ws, slot, name);

  room.players.set(player.id, player);
  clients.set(ws, { roomCode, playerId: player.id });

  safeSend(ws, {
    type: 'joined',
    roomCode,
    phase: room.phase,
    round: room.round,
    you: serializePlayer(player),
    players: [...room.players.values()].map(serializePlayer)
  });

  broadcast(
    room,
    { type: 'playerJoined', player: serializePlayer(player) },
    player.id
  );

  if (room.players.size === MAX_PLAYERS) {
    room.phase = 'ready';

    broadcast(room, {
      type: 'roomReady',
      players: [...room.players.values()].map(serializePlayer)
    });
  }
}

function leaveRoom(ws) {
  const meta = clients.get(ws);

  if (!meta) {
    return;
  }

  const room = rooms.get(meta.roomCode);

  if (room) {
    const player = room.players.get(meta.playerId);

    room.players.delete(meta.playerId);
    clearRoomTimer(room);
    room.phase = 'waiting';
    room.startedAt = 0;

    for (const remainingPlayer of room.players.values()) {
      remainingPlayer.ready = false;
      resetPlayer(remainingPlayer);
    }

    broadcast(room, {
      type: 'playerLeft',
      playerId: meta.playerId,
      name: player?.name || 'Opponent'
    });

    if (room.players.size === 0) {
      rooms.delete(meta.roomCode);
    }
  }

  clients.delete(ws);
}

function getContext(ws) {
  const meta = clients.get(ws);

  if (!meta) {
    return null;
  }

  const room = rooms.get(meta.roomCode);
  const player = room?.players.get(meta.playerId);

  if (!room || !player) {
    return null;
  }

  return { meta, room, player };
}

wss.on('connection', ws => {
  ws.isAlive = true;

  safeSend(ws, {
    type: 'hello',
    serverTime: Date.now(),
    version: 2
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: 'error', message: 'INVALID_JSON' });
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      return;
    }

    if (msg.type === 'createRoom') {
      if (clients.has(ws)) {
        leaveRoom(ws);
      }

      const room = createRoom();
      joinRoom(ws, room.code, msg.name);
      return;
    }

    if (msg.type === 'joinRoom') {
      if (clients.has(ws)) {
        leaveRoom(ws);
      }

      const roomCode = String(msg.roomCode || '').trim().toUpperCase();
      joinRoom(ws, roomCode, msg.name);
      return;
    }

    const context = getContext(ws);

    if (!context) {
      return;
    }

    const { room, player } = context;
    player.lastSeenAt = Date.now();

    if (msg.type === 'ready') {
      player.ready = true;

      broadcast(room, {
        type: 'readyState',
        players: [...room.players.values()].map(serializePlayer)
      });

      if (
        room.phase === 'ready' &&
        room.players.size === MAX_PLAYERS &&
        [...room.players.values()].every(item => item.ready)
      ) {
        startRound(room, 'matchStart');
      }

      return;
    }

    if (msg.type === 'state') {
      const now = Date.now();

      if (now - player.lastStateAt < 25) {
        return;
      }

      player.lastStateAt = now;

      const numberKeys = ['x', 'y', 'z', 'yaw', 'pitch', 'velocityX', 'velocityZ'];

      if (!numberKeys.every(key => Number.isFinite(Number(msg[key])))) {
        return;
      }

      player.x = Math.max(-23.2, Math.min(23.2, Number(msg.x)));
      player.y = Math.max(1.0, Math.min(1.85, Number(msg.y)));
      player.z = Math.max(-68.5, Math.min(33.5, Number(msg.z)));
      player.yaw = Number(msg.yaw);
      player.pitch = Math.max(-1.4, Math.min(1.4, Number(msg.pitch)));
      player.velocityX = Math.max(-9, Math.min(9, Number(msg.velocityX)));
      player.velocityZ = Math.max(-9, Math.min(9, Number(msg.velocityZ)));
      player.aiming = Boolean(msg.aiming);
      player.crouched = Boolean(msg.crouched);
      player.sprinting = Boolean(msg.sprinting);
      player.moving = Boolean(msg.moving);

      broadcast(
        room,
        {
          type: 'state',
          player: serializePlayer(player),
          serverTime: now
        },
        player.id
      );

      return;
    }

    if (msg.type === 'shoot') {
      if (room.phase !== 'live' || !player.alive) {
        return;
      }

      const now = Date.now();

      if (now - player.lastShotAt < 70) {
        return;
      }

      player.lastShotAt = now;

      broadcast(
        room,
        {
          type: 'shot',
          playerId: player.id,
          serverTime: now
        },
        player.id
      );

      return;
    }

    if (msg.type === 'hit') {
      if (room.phase !== 'live' || !player.alive) {
        return;
      }

      // A reported hit must closely follow a legal shot.
      if (Date.now() - player.lastShotAt > 260) {
        return;
      }

      const target = room.players.get(String(msg.targetId || ''));

      if (!target || target.id === player.id || !target.alive) {
        return;
      }

      const zone = msg.zone === 'head' ? 'head' : 'body';
      const damage = zone === 'head' ? HEAD_DAMAGE : BODY_DAMAGE;

      target.hp = Math.max(0, target.hp - damage);

      safeSend(player.ws, {
        type: 'hitConfirmed',
        targetId: target.id,
        zone,
        damage,
        targetHp: target.hp
      });

      broadcast(room, {
        type: 'damage',
        targetId: target.id,
        attackerId: player.id,
        zone,
        damage,
        hp: target.hp
      });

      if (target.hp <= 0) {
        endRound(room, player, target);
      }

      return;
    }

    if (msg.type === 'ping') {
      safeSend(ws, {
        type: 'pong',
        clientTime: msg.clientTime,
        serverTime: Date.now()
      });
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

const maintenanceInterval = setInterval(() => {
  const now = Date.now();

  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }

    client.isAlive = false;
    client.ping();
  }

  for (const [roomCode, room] of rooms) {
    if (room.players.size === 0 || now - room.createdAt > MAX_ROOM_AGE_MS) {
      clearRoomTimer(room);
      rooms.delete(roomCode);
    }
  }
}, 30000);

maintenanceInterval.unref();

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tactical CQB multiplayer v2 running on port ${PORT}`);
});
