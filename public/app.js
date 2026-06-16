const size = 15;
const canvas = document.querySelector("#boardCanvas");
const ctx = canvas.getContext("2d");

const elements = {
  connectionStatus: document.querySelector("#connectionStatus"),
  gameStatus: document.querySelector("#gameStatus"),
  playForm: document.querySelector("#playForm"),
  nameInput: document.querySelector("#nameInput"),
  enterButton: document.querySelector("#enterButton"),
  copyLinkButton: document.querySelector("#copyLinkButton"),
  resetButton: document.querySelector("#resetButton"),
  soundButton: document.querySelector("#soundButton"),
  matchStatus: document.querySelector("#matchStatus"),
  blackPlayer: document.querySelector("#blackPlayer"),
  whitePlayer: document.querySelector("#whitePlayer"),
  moveCount: document.querySelector("#moveCount"),
  myRole: document.querySelector("#myRole"),
  turnTimer: document.querySelector("#turnTimer"),
  topTurnTimer: document.querySelector("#topTurnTimer"),
  turnLabel: document.querySelector("#turnLabel"),
  moveList: document.querySelector("#moveList"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  chatLog: document.querySelector("#chatLog"),
  toast: document.querySelector("#toast")
};

const state = {
  socket: null,
  connected: false,
  joined: false,
  room: null,
  myRole: null,
  board: Array(size * size).fill(0),
  hoverIndex: null,
  cellGap: 0,
  boardStart: 0,
  boardEnd: 0,
  lastMoveCount: null,
  lastWinner: null,
  lastTurn: null,
  lastTimeoutCount: null,
  lastCountdownSecond: null
};

const audio = {
  context: null,
  enabled: localStorage.getItem("gomokuSound") !== "off",
  volume: 1.8
};

const roleNames = {
  black: "黑棋",
  white: "白棋",
  watcher: "观战",
  null: "未入局"
};

const savedName = localStorage.getItem("gomokuName");
const clientKey = getClientKey();
if (savedName) elements.nameInput.value = savedName;

drawBoard();
syncControls();
updateSoundButton();
setInterval(refreshTimer, 200);

elements.playForm.addEventListener("submit", event => {
  event.preventDefault();
  unlockAudio();
  joinPrivateGame();
});

elements.copyLinkButton.addEventListener("click", async () => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  try {
    await navigator.clipboard.writeText(url.toString());
    showToast("链接已复制，发给朋友即可。");
  } catch {
    showToast(url.toString());
  }
});

elements.resetButton.addEventListener("click", () => {
  send({ type: "reset" });
});

elements.soundButton.addEventListener("click", () => {
  audio.enabled = !audio.enabled;
  localStorage.setItem("gomokuSound", audio.enabled ? "on" : "off");
  updateSoundButton();
  if (audio.enabled) {
    unlockAudio();
    playSound("move");
  }
});

elements.chatForm.addEventListener("submit", event => {
  event.preventDefault();
  send({ type: "chat", text: elements.chatInput.value });
  elements.chatInput.value = "";
});

canvas.addEventListener("mousemove", event => {
  state.hoverIndex = getIndexFromEvent(event);
  drawBoard();
});

canvas.addEventListener("mouseleave", () => {
  state.hoverIndex = null;
  drawBoard();
});

canvas.addEventListener("click", event => {
  unlockAudio();
  const index = getIndexFromEvent(event);
  if (index === null) return;
  send({ type: "move", index });
});

window.addEventListener("resize", drawBoard);

function joinPrivateGame() {
  localStorage.setItem("gomokuName", getPlayerName());

  if (state.socket?.readyState === WebSocket.OPEN) {
    send({ type: "joinPrivate", name: getPlayerName(), key: clientKey });
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
  state.socket = socket;
  updateConnection("连接中");

  socket.addEventListener("open", () => {
    state.connected = true;
    updateConnection("已连接");
    send({ type: "joinPrivate", name: getPlayerName(), key: clientKey });
  });

  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    handleServerMessage(message);
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    state.joined = false;
    updateConnection("已断开", true);
    elements.gameStatus.textContent = "连接已断开，重新进入对局即可继续。";
    syncControls();
  });

  socket.addEventListener("error", () => {
    showToast("连接失败，请确认服务正在运行。");
  });
}

function send(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    showToast("还没有进入对局。");
    return;
  }
  state.socket.send(JSON.stringify(message));
}

function handleServerMessage(message) {
  if (message.type === "connected") return;

  if (message.type === "roomJoined") {
    state.myRole = message.role;
    state.joined = true;
    showToast(message.role === "watcher" ? "当前已有两位玩家，已进入观战。" : `已进入，执${roleNames[message.role]}。`);
    syncControls();
    return;
  }

  if (message.type === "state") {
    applyRoomState(message.state);
    return;
  }

  if (message.type === "chat") {
    appendChat(message.entry);
    return;
  }

  if (message.type === "notice") {
    showToast(message.message);
    return;
  }

  if (message.type === "error") {
    showToast(message.message);
  }
}

function applyRoomState(room) {
  processSoundCues(room);
  state.room = room;
  state.board = room.board;

  elements.matchStatus.textContent = getMatchStatus(room);
  elements.moveCount.textContent = room.moveCount;
  elements.myRole.textContent = roleNames[state.myRole] || "未入局";

  renderPlayer(elements.blackPlayer, "black", room.players.black, room.turn);
  renderPlayer(elements.whitePlayer, "white", room.players.white, room.turn);
  renderMoves(room);
  renderChats(room.chats);
  updateStatus(room);
  refreshTimer();
  syncControls();
  drawBoard();
}

function processSoundCues(room) {
  if (state.lastTurn !== room.turn) {
    state.lastCountdownSecond = null;
  }

  if (state.lastMoveCount !== null && room.moveCount > state.lastMoveCount) {
    playSound("move");
  }
  state.lastMoveCount = room.moveCount;

  if (
    state.lastTimeoutCount !== null &&
    Number.isFinite(room.timeoutCount) &&
    room.timeoutCount > state.lastTimeoutCount
  ) {
    playSound("timeoutPass");
  }
  state.lastTimeoutCount = Number.isFinite(room.timeoutCount) ? room.timeoutCount : 0;
  state.lastTurn = room.turn;

  if (room.winner && room.winner !== state.lastWinner) {
    playSound(room.winReason === "timeout" ? "timeout" : "win");
  }
  state.lastWinner = room.winner || null;
}

function renderPlayer(container, role, player, turn) {
  const name = player?.name || "等待玩家";
  container.classList.toggle("active", turn === role && !state.room?.winner);
  container.querySelector("strong").textContent = name;
}

function renderMoves(room) {
  const moves = room.moves || [];
  elements.moveList.replaceChildren();

  if (moves.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "还没有落子";
    elements.moveList.append(empty);
    return;
  }

  const start = room.moveCount - moves.length;
  for (const [offset, move] of moves.entries()) {
    const item = document.createElement("li");
    const row = Math.floor(move.index / size) + 1;
    const column = (move.index % size) + 1;
    item.textContent = `${start + offset + 1}. ${roleNames[move.role]} ${move.name} 落在 ${column}, ${row}`;
    elements.moveList.append(item);
  }
  elements.moveList.scrollTop = elements.moveList.scrollHeight;
}

function renderChats(chats = []) {
  elements.chatLog.replaceChildren();
  if (chats.length === 0) {
    const empty = document.createElement("div");
    empty.className = "chat-message";
    empty.textContent = "对局消息会显示在这里。";
    elements.chatLog.append(empty);
    return;
  }

  for (const entry of chats.slice(-30)) {
    appendChat(entry, false);
  }
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

function appendChat(entry, shouldScroll = true) {
  if (!entry) return;
  const node = document.createElement("div");
  node.className = "chat-message";
  const name = document.createElement("strong");
  name.textContent = `${entry.name} · ${roleNames[entry.role] || "观战"}`;
  const text = document.createElement("span");
  text.textContent = entry.text;
  node.append(name, text);
  elements.chatLog.append(node);

  while (elements.chatLog.children.length > 30) {
    elements.chatLog.firstElementChild.remove();
  }

  if (shouldScroll) {
    elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  }
}

function updateStatus(room) {
  if (!state.joined) {
    elements.gameStatus.textContent = "输入昵称进入私人对局，前两位进入者自动成为黑棋和白棋。";
    return;
  }

  if (!room.players.black || !room.players.white) {
    elements.gameStatus.textContent = "已进入私人对局，等待另一位玩家。";
    return;
  }

  if (room.winner) {
    elements.gameStatus.textContent = `${roleNames[room.winner]}五连获胜。`;
    return;
  }

  if (room.draw) {
    elements.gameStatus.textContent = "棋盘已满，平局。";
    return;
  }

  const isMyTurn = state.myRole === room.turn;
  if (state.myRole === "watcher") {
    elements.gameStatus.textContent = `正在对局，轮到${roleNames[room.turn]}。`;
  } else if (isMyTurn) {
    elements.gameStatus.textContent = "轮到你了，20 秒内落子；超时会自动换手。";
  } else {
    elements.gameStatus.textContent = `等待${roleNames[room.turn]}落子。`;
  }
}

function getMatchStatus(room) {
  if (!state.joined) return "未进入";
  if (room.winner || room.draw) return "已结束";
  if (!room.players.black || !room.players.white) return "等待对手";
  return "进行中";
}

function refreshTimer() {
  const room = state.room;
  if (!room || !room.turnDeadlineAt || room.winner || room.draw || !room.players.black || !room.players.white) {
    updateTimerDisplay("--", "等待对局", false);
    state.lastCountdownSecond = null;
    return;
  }

  const remainingMs = Math.max(0, room.turnDeadlineAt - Date.now());
  const secondsLeft = Math.ceil(remainingMs / 1000);
  updateTimerDisplay(`${secondsLeft}s`, `轮到${roleNames[room.turn]}`, secondsLeft <= 5);

  if (secondsLeft > 0 && secondsLeft <= 5 && secondsLeft !== state.lastCountdownSecond) {
    state.lastCountdownSecond = secondsLeft;
    playSound(secondsLeft <= 3 ? "urgentTick" : "tick");
  }
}

function updateTimerDisplay(value, label, warning) {
  elements.turnTimer.textContent = value;
  elements.topTurnTimer.textContent = value;
  elements.turnLabel.textContent = label;
  elements.turnTimer.classList.toggle("warning", warning);
  elements.topTurnTimer.classList.toggle("warning", warning);
}

function syncControls() {
  const inGame = Boolean(state.room?.code);
  const isPlayer = ["black", "white"].includes(state.myRole);
  elements.enterButton.disabled = state.connected && state.joined;
  elements.copyLinkButton.disabled = false;
  elements.resetButton.disabled = !isPlayer || !state.connected;
  elements.chatInput.disabled = !inGame || !state.connected;
}

function updateConnection(text, offline = false) {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.classList.toggle("offline", offline);
}

function updateSoundButton() {
  elements.soundButton.textContent = audio.enabled ? "♪" : "×";
  elements.soundButton.title = audio.enabled ? "关闭音效" : "开启音效";
  elements.soundButton.setAttribute("aria-label", audio.enabled ? "关闭音效" : "开启音效");
}

function drawBoard() {
  const scale = window.devicePixelRatio || 1;
  const cssSize = canvas.getBoundingClientRect().width || 900;
  canvas.width = Math.round(cssSize * scale);
  canvas.height = Math.round(cssSize * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const padding = cssSize * 0.07;
  const end = cssSize - padding;
  const gap = (end - padding) / (size - 1);
  state.cellGap = gap;
  state.boardStart = padding;
  state.boardEnd = end;

  ctx.fillStyle = "#d99b52";
  roundRect(ctx, 0, 0, cssSize, cssSize, Math.max(6, cssSize * 0.01));
  ctx.fill();

  ctx.strokeStyle = "rgba(74, 45, 17, 0.66)";
  ctx.lineWidth = Math.max(1, cssSize * 0.002);
  for (let index = 0; index < size; index += 1) {
    const point = padding + gap * index;
    ctx.beginPath();
    ctx.moveTo(padding, point);
    ctx.lineTo(end, point);
    ctx.moveTo(point, padding);
    ctx.lineTo(point, end);
    ctx.stroke();
  }

  drawStarPoints(padding, gap);
  drawStones(padding, gap);
  drawHover(padding, gap);
  drawWinningLine(padding, gap);
}

function drawStarPoints(padding, gap) {
  ctx.fillStyle = "rgba(58, 34, 12, 0.78)";
  for (const [x, y] of [
    [3, 3],
    [11, 3],
    [7, 7],
    [3, 11],
    [11, 11]
  ]) {
    ctx.beginPath();
    ctx.arc(padding + gap * x, padding + gap * y, gap * 0.11, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStones(padding, gap) {
  const radius = gap * 0.41;
  for (let index = 0; index < state.board.length; index += 1) {
    const value = state.board[index];
    if (!value) continue;
    const x = padding + (index % size) * gap;
    const y = padding + Math.floor(index / size) * gap;
    drawStone(x, y, radius, value === 1 ? "black" : "white");
  }
}

function drawStone(x, y, radius, color) {
  const gradient = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.38,
    radius * 0.12,
    x,
    y,
    radius
  );

  if (color === "black") {
    gradient.addColorStop(0, "#69737e");
    gradient.addColorStop(0.45, "#1c2229");
    gradient.addColorStop(1, "#050607");
  } else {
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.55, "#f5f7f8");
    gradient.addColorStop(1, "#c9d0d5");
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = color === "black" ? "rgba(0,0,0,.35)" : "rgba(98,112,132,.38)";
  ctx.lineWidth = Math.max(1, radius * 0.08);
  ctx.stroke();
}

function drawHover(padding, gap) {
  if (state.hoverIndex === null || state.board[state.hoverIndex]) return;
  if (!state.room || state.room.turn !== state.myRole || state.room.winner || state.room.draw) return;

  const x = padding + (state.hoverIndex % size) * gap;
  const y = padding + Math.floor(state.hoverIndex / size) * gap;
  ctx.beginPath();
  ctx.arc(x, y, gap * 0.41, 0, Math.PI * 2);
  ctx.fillStyle = state.myRole === "black" ? "rgba(5, 6, 7, 0.28)" : "rgba(255, 255, 255, 0.62)";
  ctx.fill();
}

function drawWinningLine(padding, gap) {
  const line = state.room?.winningLine;
  if (!line?.length) return;

  ctx.strokeStyle = "#b3343d";
  ctx.lineWidth = Math.max(4, gap * 0.12);
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const [step, index] of line.entries()) {
    const x = padding + (index % size) * gap;
    const y = padding + Math.floor(index / size) * gap;
    if (step === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function getIndexFromEvent(event) {
  if (!state.cellGap) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const column = Math.round((x - state.boardStart) / state.cellGap);
  const row = Math.round((y - state.boardStart) / state.cellGap);
  if (column < 0 || column >= size || row < 0 || row >= size) return null;

  const pointX = state.boardStart + column * state.cellGap;
  const pointY = state.boardStart + row * state.cellGap;
  const distance = Math.hypot(pointX - x, pointY - y);
  if (distance > state.cellGap * 0.46) return null;
  return row * size + column;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function getPlayerName() {
  return (elements.nameInput.value || "玩家").trim().slice(0, 18) || "玩家";
}

function getClientKey() {
  const saved = localStorage.getItem("gomokuClientKey");
  if (saved) return saved;
  const generated = crypto.randomUUID();
  localStorage.setItem("gomokuClientKey", generated);
  return generated;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    elements.toast.classList.remove("show");
  }, 2200);
}

function unlockAudio() {
  if (!audio.enabled) return;
  try {
    audio.context ||= new AudioContext();
    if (audio.context.state === "suspended") {
      audio.context.resume();
    }
  } catch {
    audio.enabled = false;
    updateSoundButton();
  }
}

function playSound(kind) {
  if (!audio.enabled) return;
  unlockAudio();
  if (!audio.context) return;

  if (kind === "move") {
    tone(520, 0.08, "sine", 0.045);
  } else if (kind === "tick") {
    tone(860, 0.07, "square", 0.04);
  } else if (kind === "urgentTick") {
    tone(1080, 0.055, "square", 0.052);
    tone(1360, 0.065, "square", 0.05, 0.085);
  } else if (kind === "timeout") {
    tone(220, 0.12, "sawtooth", 0.055);
    tone(150, 0.24, "sawtooth", 0.045, 0.12);
    tone(95, 0.32, "sawtooth", 0.035, 0.28);
  } else if (kind === "timeoutPass") {
    tone(360, 0.11, "square", 0.07);
    tone(520, 0.11, "square", 0.06, 0.1);
  } else if (kind === "win") {
    tone(520, 0.12, "sine", 0.04);
    tone(660, 0.12, "sine", 0.04, 0.1);
    tone(820, 0.2, "sine", 0.04, 0.2);
  }
}

function tone(frequency, duration, type, gainValue, delay = 0) {
  const context = audio.context;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const peakGain = Math.min(gainValue * audio.volume, 0.12);

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}
