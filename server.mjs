import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const size = 15;
const privateRoomCode = "PRIVATE";
const turnLimitMs = Number(process.env.TURN_LIMIT_MS || 20_000);
const heartbeatIntervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS || 30_000);

const clients = new Map();
const rooms = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = normalize(join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  createReadStream(filePath).pipe(response);
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  const client = {
    id: randomUUID(),
    name: "玩家",
    roomCode: null,
    role: null,
    key: null,
    socket,
    buffer: Buffer.alloc(0),
    closed: false,
    alive: true
  };
  clients.set(client.id, client);

  socket.on("data", chunk => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    try {
      readFrames(client);
    } catch {
      closeClient(client);
    }
  });

  socket.on("close", () => closeClient(client));
  socket.on("error", () => closeClient(client));

  send(client, { type: "connected", clientId: client.id });
});

server.listen(port, host, () => {
  console.log(`Gomoku Online is running at http://localhost:${port}`);
});

const heartbeatTimer = setInterval(() => {
  for (const client of clients.values()) {
    if (client.closed || client.socket.destroyed) {
      closeClient(client);
      continue;
    }

    if (!client.alive) {
      closeClient(client);
      continue;
    }

    client.alive = false;
    client.socket.write(encodeFrame(Buffer.alloc(0), 0x9));
  }
}, heartbeatIntervalMs);
heartbeatTimer.unref?.();

function makeRoom(code = generateRoomCode()) {
  return {
    code,
    board: Array(size * size).fill(0),
    players: { black: null, white: null },
    watchers: new Set(),
    turn: "black",
    winner: null,
    winningLine: [],
    draw: false,
    winReason: null,
    timeoutCount: 0,
    turnStartedAt: null,
    turnDeadlineAt: null,
    turnTimer: null,
    moves: [],
    chats: [],
    createdAt: Date.now()
  };
}

function generateRoomCode() {
  return privateRoomCode;
}

function readFrames(client) {
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      const bigLength = client.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(1024 * 1024)) {
        throw new Error("Frame is too large");
      }
      length = Number(bigLength);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;

    const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
    offset += maskLength;
    const rawPayload = client.buffer.subarray(offset, offset + length);
    client.buffer = client.buffer.subarray(offset + length);
    client.alive = true;
    const payload = Buffer.alloc(rawPayload.length);
    for (let index = 0; index < rawPayload.length; index += 1) {
      payload[index] = mask ? rawPayload[index] ^ mask[index % 4] : rawPayload[index];
    }

    if (opcode === 0x8) {
      closeClient(client);
      return;
    }

    if (opcode === 0x9) {
      client.socket.write(encodeFrame(payload, 0xA));
      continue;
    }

    if (opcode === 0xA) {
      continue;
    }

    if (opcode !== 0x1) {
      continue;
    }

    const message = JSON.parse(payload.toString("utf8"));
    handleMessage(client, message);
  }
}

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}

function send(client, data) {
  if (!client || client.closed || client.socket.destroyed) return;
  client.socket.write(encodeFrame(JSON.stringify(data)));
}

function broadcast(room, data) {
  for (const client of roomClients(room)) {
    send(client, data);
  }
}

function handleMessage(client, message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "joinPrivate") {
    client.name = cleanName(message.name);
    client.key = cleanKey(message.key);
    joinRoom(client, getPrivateRoom());
    return;
  }

  if (message.type === "createRoom") {
    client.name = cleanName(message.name);
    client.key = cleanKey(message.key);
    joinRoom(client, getPrivateRoom());
    return;
  }

  if (message.type === "joinRoom") {
    client.name = cleanName(message.name);
    client.key = cleanKey(message.key);
    joinRoom(client, getPrivateRoom());
    return;
  }

  if (message.type === "move") {
    playMove(client, message.index);
    return;
  }

  if (message.type === "reset") {
    resetRoom(client);
    return;
  }

  if (message.type === "chat") {
    addChat(client, message.text);
  }
}

function getPrivateRoom() {
  if (!rooms.has(privateRoomCode)) {
    rooms.set(privateRoomCode, makeRoom(privateRoomCode));
  }
  return rooms.get(privateRoomCode);
}

function joinRoom(client, room, preferredRole = null) {
  leaveCurrentRoom(client);
  client.roomCode = room.code;

  const reclaimed = reclaimRole(client, room);
  const openRole = preferredRole || (room.players.black ? "white" : "black");
  if (reclaimed) {
    client.role = reclaimed;
  } else if (!room.players[openRole]) {
    client.role = openRole;
    room.players[openRole] = client.id;
  } else if (!room.players.white) {
    client.role = "white";
    room.players.white = client.id;
  } else if (!room.players.black) {
    client.role = "black";
    room.players.black = client.id;
  } else {
    client.role = "watcher";
    room.watchers.add(client.id);
  }

  ensureTurnTimer(room);
  send(client, { type: "roomJoined", roomCode: room.code, role: client.role });
  broadcastState(room);
}

function reclaimRole(client, room) {
  for (const role of ["black", "white"]) {
    const existingId = room.players[role];
    const existingClient = existingId ? clients.get(existingId) : null;
    if (existingClient?.key && existingClient.key === client.key) {
      if (existingClient.id !== client.id) {
        existingClient.role = null;
        existingClient.roomCode = null;
        existingClient.socket.end();
        clients.delete(existingClient.id);
      }
      room.players[role] = client.id;
      return role;
    }
  }
  return null;
}

function leaveCurrentRoom(client) {
  if (!client.roomCode) return;
  const room = rooms.get(client.roomCode);
  if (!room) return;

  if (client.role === "black" && room.players.black === client.id) {
    room.players.black = null;
  } else if (client.role === "white" && room.players.white === client.id) {
    room.players.white = null;
  } else {
    room.watchers.delete(client.id);
  }

  client.roomCode = null;
  client.role = null;
  if (room.code === privateRoomCode && roomClients(room).length === 0) {
    resetBoard(room);
  }
  ensureTurnTimer(room);
  broadcastState(room);
  pruneRoom(room);
}

function closeClient(client) {
  if (client.closed) return;
  client.closed = true;
  leaveCurrentRoom(client);
  clients.delete(client.id);
  client.socket.destroy();
}

function playMove(client, index) {
  const room = getClientRoom(client);
  if (!room) return;

  const point = Number(index);
  if (!Number.isInteger(point) || point < 0 || point >= size * size) {
    return;
  }

  if (room.winner || room.draw) {
    send(client, { type: "error", message: "这一局已经结束。" });
    return;
  }

  if (isTurnExpired(room)) {
    expireTurn(room);
    return;
  }

  if (client.role !== room.turn) {
    send(client, { type: "error", message: "现在还没有轮到你。" });
    return;
  }

  if (room.board[point] !== 0) {
    send(client, { type: "error", message: "这里已经有棋子了。" });
    return;
  }

  const stone = client.role === "black" ? 1 : 2;
  room.board[point] = stone;
  room.moves.push({ index: point, role: client.role, name: client.name, at: Date.now() });

  const win = getWinningLine(room.board, point, stone);
  if (win) {
    room.winner = client.role;
    room.winReason = "five";
    room.winningLine = win;
    clearTurnTimer(room);
  } else if (room.moves.length === room.board.length) {
    room.draw = true;
    clearTurnTimer(room);
  } else {
    room.turn = client.role === "black" ? "white" : "black";
    startTurnTimer(room);
  }

  broadcastState(room);
}

function resetRoom(client) {
  const room = getClientRoom(client);
  if (!room || !["black", "white"].includes(client.role)) return;

  resetBoard(room);
  ensureTurnTimer(room, true);
  broadcast(room, {
    type: "notice",
    message: `${client.name} 开始了新一局。`
  });
  broadcastState(room);
}

function addChat(client, text) {
  const room = getClientRoom(client);
  if (!room) return;

  const message = String(text || "").trim().slice(0, 120);
  if (!message) return;

  const entry = {
    id: randomUUID(),
    name: client.name,
    role: client.role,
    text: message,
    at: Date.now()
  };
  room.chats.push(entry);
  room.chats = room.chats.slice(-30);
  broadcast(room, { type: "chat", entry });
}

function getWinningLine(board, point, stone) {
  const row = Math.floor(point / size);
  const column = point % size;
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];

  for (const [dx, dy] of directions) {
    const line = [[column, row]];
    for (const sign of [-1, 1]) {
      let nextColumn = column + dx * sign;
      let nextRow = row + dy * sign;
      while (
        nextColumn >= 0 &&
        nextColumn < size &&
        nextRow >= 0 &&
        nextRow < size &&
        board[nextRow * size + nextColumn] === stone
      ) {
        if (sign < 0) {
          line.unshift([nextColumn, nextRow]);
        } else {
          line.push([nextColumn, nextRow]);
        }
        nextColumn += dx * sign;
        nextRow += dy * sign;
      }
    }

    if (line.length >= 5) {
      return line.slice(0, 5).map(([x, y]) => y * size + x);
    }
  }

  return null;
}

function broadcastState(room) {
  broadcast(room, {
    type: "state",
    state: serializeRoom(room)
  });
}

function serializeRoom(room) {
  const players = Object.fromEntries(
    ["black", "white"].map(role => {
      const player = clients.get(room.players[role]);
      return [
        role,
        player
          ? {
              id: player.id,
              name: player.name,
              online: !player.closed
            }
          : null
      ];
    })
  );

  return {
    code: room.code,
    board: room.board,
    players,
    watcherCount: room.watchers.size,
    turn: room.turn,
    winner: room.winner,
    winReason: room.winReason,
    timeoutCount: room.timeoutCount,
    winningLine: room.winningLine,
    draw: room.draw,
    timeLimitMs: turnLimitMs,
    turnStartedAt: room.turnStartedAt,
    turnDeadlineAt: room.turnDeadlineAt,
    moveCount: room.moves.length,
    moves: room.moves.slice(-12),
    lastMove: room.moves.at(-1) || null,
    chats: room.chats
  };
}

function roomClients(room) {
  const ids = new Set([room.players.black, room.players.white, ...room.watchers]);
  return [...ids].map(id => clients.get(id)).filter(Boolean);
}

function getClientRoom(client) {
  return client.roomCode ? rooms.get(client.roomCode) : null;
}

function pruneRoom(room) {
  if (room.code === privateRoomCode) return;
  const activeClients = roomClients(room);
  if (activeClients.length > 0) return;

  setTimeout(() => {
    const latest = rooms.get(room.code);
    if (latest && roomClients(latest).length === 0) {
      rooms.delete(room.code);
    }
  }, 5 * 60 * 1000);
}

function cleanName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
  return name || "玩家";
}

function cleanRoomCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function cleanKey(value) {
  return String(value || "").trim().slice(0, 80);
}

function resetBoard(room) {
  room.board = Array(size * size).fill(0);
  room.turn = "black";
  room.winner = null;
  room.winningLine = [];
  room.draw = false;
  room.winReason = null;
  room.timeoutCount = 0;
  room.turnStartedAt = null;
  room.turnDeadlineAt = null;
  room.moves = [];
  clearTurnTimer(room);
}

function bothPlayersReady(room) {
  return Boolean(room.players.black && room.players.white);
}

function isGameActive(room) {
  return bothPlayersReady(room) && !room.winner && !room.draw;
}

function ensureTurnTimer(room, forceRestart = false) {
  if (!isGameActive(room)) {
    clearTurnTimer(room, true);
    return;
  }

  if (forceRestart || !room.turnDeadlineAt) {
    startTurnTimer(room);
  }
}

function startTurnTimer(room) {
  clearTurnTimer(room);
  const now = Date.now();
  room.turnStartedAt = now;
  room.turnDeadlineAt = now + turnLimitMs;
  room.turnTimer = setTimeout(() => {
    expireTurn(room);
  }, turnLimitMs + 25);
}

function clearTurnTimer(room, clearDeadline = false) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }

  if (clearDeadline) {
    room.turnStartedAt = null;
    room.turnDeadlineAt = null;
  }
}

function isTurnExpired(room) {
  return isGameActive(room) && room.turnDeadlineAt && Date.now() >= room.turnDeadlineAt;
}

function expireTurn(room) {
  if (!isTurnExpired(room) || room.winner || room.draw) return;

  const skipped = room.turn;
  room.turn = skipped === "black" ? "white" : "black";
  room.timeoutCount += 1;
  startTurnTimer(room);
  broadcast(room, {
    type: "notice",
    message: `${roleLabel(skipped)}超时，轮到${roleLabel(room.turn)}。`
  });
  broadcastState(room);
}

function roleLabel(role) {
  return role === "black" ? "黑棋" : "白棋";
}
