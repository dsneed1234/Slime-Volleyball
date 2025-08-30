const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// Serve static files (the client HTML/JS)
app.use(express.static(path.join(__dirname, "public")));

// ----------------- LOBBY / GAME STATE -----------------

let lobbies = {}; // roomCode -> { players: [ws1, ws2], gameState }

function createGameState() {
  const WIDTH = 600, HEIGHT = 400, SLIME_RADIUS = 30, BALL_RADIUS = 12;
  return {
    width: WIDTH,
    height: HEIGHT,
    netHeight: 80,
    netX: WIDTH / 2 - 2,
    ball: { x: WIDTH / 2, y: 100, vx: 3, vy: -2 },
    slimes: [
      { x: 150, y: HEIGHT - SLIME_RADIUS, vx: 0, vy: 0, jumping: false, score: 0 }, // P1
      { x: 450, y: HEIGHT - SLIME_RADIUS, vx: 0, vy: 0, jumping: false, score: 0 }, // P2
    ],
    match: { p1Wins: 0, p2Wins: 0, bestOf: 3, started: false },
  };
}

// Game loop per room
function startGameLoop(roomCode) {
  const FPS = 60;
  setInterval(() => {
    let lobby = lobbies[roomCode];
    if (!lobby || !lobby.gameState.match.started) return;

    let g = lobby.gameState;
    let b = g.ball;

    // update slimes
    for (let s of g.slimes) {
      s.x += s.vx;
      s.y += s.vy;
      s.vy += 0.3; // gravity

      if (s.y > g.height - 30) {
        s.y = g.height - 30;
        s.vy = 0;
        s.jumping = false;
      }

      if (s.x < 30) s.x = 30;
      if (s.x > g.width - 30) s.x = g.width - 30;
    }

    // update ball
    b.x += b.vx;
    b.y += b.vy;
    b.vy += 0.25;

    // floor (score)
    if (b.y > g.height - 12) {
      if (b.x < g.width / 2) {
        g.slimes[1].score++;
        resetBall(g);
      } else {
        g.slimes[0].score++;
        resetBall(g);
      }

      // check winning condition (first to 5 points wins a set)
      if (g.slimes[0].score >= 5 || g.slimes[1].score >= 5) {
        if (g.slimes[0].score > g.slimes[1].score) g.match.p1Wins++;
        else g.match.p2Wins++;
        g.slimes[0].score = 0;
        g.slimes[1].score = 0;
        resetBall(g);

        // check match end
        const needed = Math.ceil(g.match.bestOf / 2);
        if (g.match.p1Wins === needed || g.match.p2Wins === needed) {
          g.match.started = false; // match over
        }
      }
    }

    // walls
    if (b.x < 12 || b.x > g.width - 12) b.vx *= -1;
    if (b.y < 12) { b.y = 12; b.vy *= -1; }

    // net
    if (
      b.x > g.width / 2 - 4 - 12 &&
      b.x < g.width / 2 + 4 + 12 &&
      b.y > g.height - g.netHeight
    ) {
      if (b.x < g.width / 2) b.x = g.width / 2 - 16;
      else b.x = g.width / 2 + 16;
      b.vx *= -1;
    }

    // slime collisions
    g.slimes.forEach((s) => {
      let dx = b.x - s.x;
      let dy = b.y - s.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 42) {
        let angle = Math.atan2(dy, dx);
        b.vx = 4 * Math.cos(angle);
        b.vy = 4 * Math.sin(angle);
        b.x = s.x + 43 * Math.cos(angle);
        b.y = s.y + 43 * Math.sin(angle);
      }
    });

    // broadcast state
    lobby.players.forEach((p) => {
      if (p.readyState === WebSocket.OPEN) {
        p.send(JSON.stringify({ type: "state", state: g }));
      }
    });
  }, 1000 / FPS);
}

function resetBall(g) {
  g.ball = { x: g.width / 2, y: 100, vx: Math.random() > 0.5 ? 3 : -3, vy: -2 };
}

// ----------------- WEBSOCKETS -----------------

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "join") {
      const { roomCode } = data;
      if (!lobbies[roomCode]) {
        lobbies[roomCode] = { players: [], gameState: createGameState() };
        startGameLoop(roomCode);
      }

      let lobby = lobbies[roomCode];
      if (lobby.players.length >= 2) {
        ws.send(JSON.stringify({ type: "full" }));
        return;
      }
      lobby.players.push(ws);
      ws.roomCode = roomCode;
      ws.playerIndex = lobby.players.length - 1;

      ws.send(JSON.stringify({ type: "joined", playerIndex: ws.playerIndex }));
    }

    if (data.type === "input") {
      let lobby = lobbies[ws.roomCode];
      if (!lobby) return;
      let s = lobby.gameState.slimes[ws.playerIndex];
      s.vx = data.vx;
      if (data.jump && !s.jumping) {
        s.vy = -7;
        s.jumping = true;
      }
    }

    if (data.type === "start") {
      let lobby = lobbies[ws.roomCode];
      if (lobby) {
        lobby.gameState.match.started = true;
        lobby.gameState.match.p1Wins = 0;
        lobby.gameState.match.p2Wins = 0;
        lobby.gameState.slimes[0].score = 0;
        lobby.gameState.slimes[1].score = 0;
        resetBall(lobby.gameState);
      }
    }
  });

  ws.on("close", () => {
    if (ws.roomCode && lobbies[ws.roomCode]) {
      lobbies[ws.roomCode].players = lobbies[ws.roomCode].players.filter((p) => p !== ws);
      if (lobbies[ws.roomCode].players.length === 0) delete lobbies[ws.roomCode];
    }
  });
});

// ----------------- START SERVER -----------------

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
