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

function playerSnapshot(player) {
  return {
    id: player.id, name: player.name, slot: player.slot,
    hp: player.hp, score: player.score, alive: player.alive,
    ...player.state
  };
}

function createPlayer(socket, slot, name = "Operator") {
  return {
    id: createId(),
    name: String(name || "Operator").trim().slice(0, 32) || "Operator",
    socket,
    slot,
    hp: 100,
    score: 0,
    kills: 0,
    deaths: 0,
    alive: true,
    state: {
      x: slot === 1 ? -7 : 7,
      y: 0,
      z: slot === 1 ? 8 : -58,
      yaw: slot === 1 ? 0 : Math.PI,
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

function handleCreateRoom(socket, message) {
  if (getRoomBySocket(socket)) return;
  const code = getUniqueRoomCode();

  const room = {
    code,
    players: new Map(),
    createdAt: Date.now()
  };

  const player = createPlayer(
    socket,
    1,
    message.name
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
    type: "joined",
    roomCode: code,
    you: playerSnapshot(player),
    players: [...room.players.values()].map(playerSnapshot)
  });

  broadcastRoomState(room);
}

function handleJoinRoom(socket, message) {
  if (getRoomBySocket(socket)) return;
  const code = String(
    message.roomCode || message.code || ""
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

  const slot = [...room.players.values()].some(p => p.slot === 1) ? 2 : 1;

  const player = createPlayer(
    socket,
    slot,
    message.name
  );

  room.players.set(
    player.id,
    player
  );

  send(socket, {
    type: "joined",
    roomCode: code,
    you: playerSnapshot(player),
    players: [...room.players.values()].map(playerSnapshot)
  });

  broadcast(room, {
    type: "playerJoined",
    player: playerSnapshot(player)
  }, player.id);

  broadcastRoomState(room);

  if (room.players.size === 2) {
    broadcast(room, {
      type: "matchCountdown",
    startAt: Date.now() + 3000
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

  const state = message.state || message;

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
      type: "state",
      player: playerSnapshot(player)
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

  broadcast(room, {
    type: "damage",
    targetId: target.id,
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
      type: "kill",
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

      target.state.yaw = target.slot === 1 ? 0 : Math.PI;
      broadcast(room, {
        type: "respawn",
        player: playerSnapshot(target)
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
    clientTime: message.clientTime || message.time || Date.now()
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
        handleCreateRoom(socket, message);
        break;

      case "joinRoom":
        handleJoinRoom(
          socket,
          message
        );
        break;

      case "state":
      case "playerState":
        handlePlayerState(
          socket,
          message
        );
        break;

      case "shoot":
      case "hit":
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