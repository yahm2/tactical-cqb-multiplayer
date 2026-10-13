import express from "express";
import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size
  });
});

const wss = new WebSocketServer({
  server,
  path: "/ws"
});

const rooms = new Map();

/*
room = {
  code,
  players: Map<playerId, player>,
  createdAt
}

player = {
  id,
  socket,
  slot,
  hp,
  score,
  kills,
  deaths,
  alive,
  state
}
*/

function createId() {
  return crypto.randomBytes(8).toString("hex");
}

function createRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 5; i++) {
    code += chars[
      Math.floor(
        Math.random() *
        chars.length
      )
    ];
  }

  return code;
}

function getUniqueRoomCode() {
  let code;

  do {
    code = createRoomCode();
  } while (rooms.has(code));

  return code;
}

function send(socket, data) {
  if (
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {
    socket.send(
      JSON.stringify(data)
    );
  }
}

function broadcast(room, data, exceptId = null) {
  for (const [playerId, player] of room.players) {
    if (playerId === exceptId) {
      continue;
    }

    send(player.socket, data);
  }
}

function broadcastRoomState(room) {
  const players = [];

  for (const player of room.players.values()) {
    players.push({
      id: player.id,
      slot: player.slot,
      hp: player.hp,
      score: player.score,
      kills: player.kills,
      deaths: player.deaths,
      alive: player.alive
    });
  }

  broadcast(room, {
    type: "roomState",
    code: room.code,
    players
  });
}

function getRoomBySocket(socket) {
  for (const room of rooms.values()) {
    for (const player of room.players.values()) {
      if (player.socket === socket) {
        return {
          room,
          player
        };
      }
    }
  }

  return null;
}

function createPlayer(socket, slot) {
  return {
    id: createId(),
    socket,
    slot,
    hp: 100,
    score: 0,
    kills: 0,
    deaths: 0,
    alive: true,
    state: {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      aiming: false,
      crouched: false,
      sprinting: false,
      fireMode: "AUTO"
    }
  };
}

function resetPlayer(player) {
  player.hp = 100;
  player.alive = true;
}

function removePlayerFromRoom(room, playerId) {
  if (!room) return;

  room.players.delete(playerId);

  broadcast(room, {
    type: "playerLeft",
    playerId
  });

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  broadcastRoomState(room);
}

function handleCreateRoom(socket) {
  const code = getUniqueRoomCode();

  const room = {
    code,
    players: new Map(),
    createdAt: Date.now()
  };

  const player = createPlayer(
    socket,
    1
  );

  room.players.set(
    player.id,
    player
  );

  rooms.set(
    code,
    room
  );

  send(socket, {
    type: "roomCreated",
    code,
    playerId: player.id,
    slot: player.slot
  });

  broadcastRoomState(room);
}

function handleJoinRoom(socket, message) {
  const code = String(
    message.code || ""
  )
    .trim()
    .toUpperCase();

  const room = rooms.get(code);

  if (!room) {
    send(socket, {
      type: "error",
      message: "ROOM_NOT_FOUND"
    });

    return;
  }

  if (room.players.size >= 2) {
    send(socket, {
      type: "error",
      message: "ROOM_FULL"
    });

    return;
  }

  const slot =
    room.players.size === 0
      ? 1
      : 2;

  const player = createPlayer(
    socket,
    slot
  );

  room.players.set(
    player.id,
    player
  );

  send(socket, {
    type: "roomJoined",
    code,
    playerId: player.id,
    slot
  });

  broadcast(room, {
    type: "playerJoined",
    playerId: player.id,
    slot
  });

  broadcastRoomState(room);

  if (room.players.size === 2) {
    broadcast(room, {
      type: "matchReady"
    });
  }
}

function handlePlayerState(socket, message) {
  const result = getRoomBySocket(socket);

  if (!result) return;

  const { room, player } = result;

  if (!player.alive) {
    return;
  }

  const state = message.state || {};

  player.state = {
    x: Number(state.x) || 0,
    y: Number(state.y) || 0,
    z: Number(state.z) || 0,
    yaw: Number(state.yaw) || 0,
    pitch: Number(state.pitch) || 0,
    aiming: Boolean(state.aiming),
    crouched: Boolean(state.crouched),
    sprinting: Boolean(state.sprinting),
    fireMode:
      state.fireMode === "SEMI"
        ? "SEMI"
        : "AUTO"
  };

  broadcast(
    room,
    {
      type: "playerState",
      playerId: player.id,
      state: player.state
    },
    player.id
  );
}

function handleShot(socket, message) {
  const result = getRoomBySocket(socket);

  if (!result) return;

  const { room, player } = result;

  if (!player.alive) {
    return;
  }

  const targetId = String(
    message.targetId || ""
  );

  const zone =
    message.zone === "head"
      ? "head"
      : "body";

  const target =
    room.players.get(targetId);

  if (!target) {
    broadcast(
      room,
      {
        type: "shot",
        playerId: player.id,
        hit: false
      },
      player.id
    );

    return;
  }

  if (
    target.id === player.id ||
    !target.alive
  ) {
    return;
  }

  const damage =
    zone === "head"
      ? 100
      : 34;

  target.hp -= damage;

  if (target.hp < 0) {
    target.hp = 0;
  }

  send(player.socket, {
    type: "hitConfirmed",
    targetId: target.id,
    zone,
    damage,
    targetHp: target.hp
  });

  send(target.socket, {
    type: "tookDamage",
    attackerId: player.id,
    zone,
    damage,
    hp: target.hp
  });

  broadcast(room, {
    type: "shot",
    playerId: player.id,
    targetId: target.id,
    zone,
    hit: true
  });

  if (target.hp <= 0) {
    target.alive = false;

    target.deaths += 1;
    player.kills += 1;
    player.score += 1;

    broadcast(room, {
      type: "playerKilled",
      killerId: player.id,
      victimId: target.id,
      killerScore: player.score,
      killerKills: player.kills,
      victimDeaths: target.deaths
    });

    broadcastRoomState(room);

    setTimeout(() => {
      if (!room.players.has(target.id)) {
        return;
      }

      resetPlayer(target);

      const spawn =
        target.slot === 1
          ? {
              x: -7,
              y: 0,
              z: 8
            }
          : {
              x: 7,
              y: 0,
              z: -58
            };

      target.state.x = spawn.x;
      target.state.y = spawn.y;
      target.state.z = spawn.z;

      send(target.socket, {
        type: "respawn",
        hp: target.hp,
        spawn
      });

      broadcast(room, {
        type: "playerRespawned",
        playerId: target.id,
        spawn
      });

      broadcastRoomState(room);
    }, 2500);
  } else {
    broadcastRoomState(room);
  }
}

function handlePing(socket, message) {
  send(socket, {
    type: "pong",
    time: message.time || Date.now()
  });
}

wss.on("connection", socket => {
  send(socket, {
    type: "connected",
    message: "TACTICAL_CQB_SERVER_READY"
  });

  socket.on("message", raw => {
    let message;

    try {
      message = JSON.parse(
        raw.toString()
      );
    } catch {
      send(socket, {
        type: "error",
        message: "INVALID_JSON"
      });

      return;
    }

    switch (message.type) {
      case "createRoom":
        handleCreateRoom(socket);
        break;

      case "joinRoom":
        handleJoinRoom(
          socket,
          message
        );
        break;

      case "playerState":
        handlePlayerState(
          socket,
          message
        );
        break;

      case "shot":
        handleShot(
          socket,
          message
        );
        break;

      case "ping":
        handlePing(
          socket,
          message
        );
        break;

      default:
        send(socket, {
          type: "error",
          message: "UNKNOWN_MESSAGE_TYPE"
        });
    }
  });

  socket.on("close", () => {
    const result =
      getRoomBySocket(socket);

    if (!result) {
      return;
    }

    const {
      room,
      player
    } = result;

    removePlayerFromRoom(
      room,
      player.id
    );
  });

  socket.on("error", error => {
    console.error(
      "WebSocket error:",
      error.message
    );
  });
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Tactical CQB multiplayer server running on port ${PORT}`
    );
  }
);