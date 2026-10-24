// Pixel Fighter multiplayer server.
// Serves the game page and relays lockstep messages between two players over WebSocket (/ws).
//
// Setup:   npm install ws
// Run:     node server.js            (PORT=3000 by default; set PORT=xxxx to change)
// Tunnel:  ngrok http 3000   or   cloudflared tunnel --url http://localhost:3000
// Then open the tunnel's https URL, click "Host a room", and share the code or link.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;

// Find the game file: index.html first, otherwise any html file with "pixel-fighter" in its name.
function findGame() {
  if (fs.existsSync(path.join(DIR, 'index.html'))) return path.join(DIR, 'index.html');
  const f = fs.readdirSync(DIR).find(n => /^pixel-fighter.*\.html$/i.test(n));
  return f ? path.join(DIR, f) : null;
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    const file = findGame();
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Game HTML not found. Put it next to server.js as index.html.');
    }
    console.log('Serving game file: ' + file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });

// rooms: code -> { host: ws, guest: ws|null }
const rooms = new Map();
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

function peerOf(ws) {
  const r = rooms.get(ws.room);
  if (!r) return null;
  return ws.role === 'host' ? r.guest : r.host;
}

function leave(ws) {
  const r = rooms.get(ws.room);
  if (!r) return;
  if (ws.role === 'host') {
    // Host left: close the room and kick the guest.
    rooms.delete(ws.room);
    if (r.guest) {
      send(r.guest, { t: 'closed' });
      r.guest.room = null;
      r.guest.close();
    }
  } else if (r.guest === ws) {
    r.guest = null;
    send(r.host, { t: 'left' });
  }
  ws.room = null;
}

// Messages that are simply forwarded to the other player in the room.
const RELAY = new Set(['p', 'q', 's', 'r', 'i', 'c', 'g']); // c/g = character select

wss.on('connection', ws => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));

  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'host') {
      if (ws.room) return;
      const c = newCode();
      if (!c) return send(ws, { t: 'err', msg: 'Server is full.' });
      rooms.set(c, { host: ws, guest: null });
      ws.room = c;
      ws.role = 'host';
      return send(ws, { t: 'hosted', c });
    }

    if (m.t === 'join') {
      if (ws.room) return;
      const c = String(m.c || '').toUpperCase();
      const r = rooms.get(c);
      if (!r) return send(ws, { t: 'err', msg: 'Room ' + c + ' not found.' });
      if (r.guest) return send(ws, { t: 'err', msg: 'Room ' + c + ' is full.' });
      r.guest = ws;
      ws.room = c;
      ws.role = 'guest';
      send(ws, { t: 'joined', c });
      return send(r.host, { t: 'peer' });
    }

    if (RELAY.has(m.t) && ws.room) {
      send(peerOf(ws), m);
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Keep connections alive through tunnels and drop dead ones.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, () => {
  console.log('Pixel Fighter server running on http://localhost:' + PORT);
  console.log('Game file: ' + (findGame() || 'NOT FOUND (place index.html next to server.js)'));
  console.log('Now tunnel it, e.g.:  ngrok http ' + PORT + '   or   cloudflared tunnel --url http://localhost:' + PORT);
});
