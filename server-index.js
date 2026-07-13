const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const SERVER_VERSION = 'ultima-ubicacion-v5';
console.log('Versión del servidor: ' + SERVER_VERSION);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 90000
});

const rooms = {};

function sanitizeRoom(room) {
  let r = String(room || '').trim().toUpperCase();
  r = r.replace(/[^A-Z0-9_-]/g, '');
  r = r.slice(0, 20);
  return r || 'FAMILIA';
}

function isCreator(room, clientId) {
  return !!(rooms[room] && rooms[room].creatorId === clientId);
}

function broadcastCount(room) {
  if (!rooms[room]) return;
  const count = Object.values(rooms[room].users).filter(u => u.online).length;
  io.to(room).emit('count', { room, count });
}

function applyLocationUpdate(clientId, room, lat, lng, name) {
  const r = rooms[room];
  if (!r || !r.users[clientId]) return false;
  r.users[clientId].lat = lat;
  r.users[clientId].lng = lng;
  r.users[clientId].updatedAt = Date.now();
  r.users[clientId].online = true;
  if (name) r.users[clientId].name = name;

  const payloadOut = {
    room,
    clientId,
    name: r.users[clientId].name,
    lat,
    lng,
    updatedAt: r.users[clientId].updatedAt,
    online: true
  };
  io.to(room).emit('user:update', payloadOut);
  return true;
}

app.post('/api/location', (req, res) => {
  const body = req.body || {};
  const clientId = String(body.clientId || '');
  const room = sanitizeRoom(body.room);
  const lat = body.lat;
  const lng = body.lng;

  if (!clientId || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ ok: false, error: 'faltan datos' });
  }

  const updated = applyLocationUpdate(clientId, room, lat, lng);
  if (!updated) {
    return res.status(200).json({ ok: false, reason: 'usuario o grupo no encontrado' });
  }
  res.status(200).json({ ok: true });
});

function markOffline(socket) {
  const clientId = socket.data.clientId;
  if (!clientId) return;
  socket.data.rooms.forEach(room => {
    const r = rooms[room];
    if (!r || !r.users[clientId]) return;
    r.users[clientId].online = false;
    r.users[clientId].updatedAt = Date.now();
    io.to(room).emit('user:offline', { room, clientId, updatedAt: r.users[clientId].updatedAt });
    broadcastCount(room);
  });
}

io.on('connection', (socket) => {
  socket.data.rooms = new Set();
  socket.data.sharingRooms = new Set();
  socket.data.clientId = null;

  socket.on('join', (payload) => {
    payload = payload || {};
    const clientId = payload.clientId || socket.id;
    const room = sanitizeRoom(payload.room);
    const name = String(payload.name || 'Usuario').trim().slice(0, 30) || 'Usuario';
    const groupName = String(payload.groupName || room).trim().slice(0, 30) || room;
    const password = String(payload.password || '');

    socket.data.clientId = clientId;

    let r = rooms[room];
    if (!r) {
      r = rooms[room] = {
        name: groupName,
        password: password,
        creatorId: clientId,
        users: {}
      };
      console.log('Grupo creado: ' + room + ' por ' + clientId);
    } else {
      if (r.password !== password) {
        socket.emit('join:denied', { room });
        return;
      }
    }

    socket.data.rooms.add(room);
    socket.join(room);

    const existing = r.users[clientId];
    r.users[clientId] = {
      clientId: clientId,
      name: name,
      lat: existing ? existing.lat : null,
      lng: existing ? existing.lng : null,
      updatedAt: existing ? existing.updatedAt : Date.now(),
      online: true
    };

    const amCreator = isCreator(room, clientId);

    socket.emit('join:ok', { room, name: r.name, isCreator: amCreator });
    if (amCreator) {
      socket.emit('room:youAreAdmin', { room });
    }

    const usersList = Object.values(r.users).filter(u => typeof u.lat === 'number' && typeof u.lng === 'number');
    socket.emit('users:init', { room, users: usersList });

    broadcastCount(room);
  });

  socket.on('room:startSharing', (payload) => {
    const room = sanitizeRoom((payload || {}).room);
    if (socket.data.rooms.has(room)) {
      socket.data.sharingRooms.add(room);
    }
  });

  socket.on('room:stopSharing', (payload) => {
    const room = sanitizeRoom((payload || {}).room);
    socket.data.sharingRooms.delete(room);
    const clientId = socket.data.clientId;
    const r = rooms[room];
    if (r && clientId && r.users[clientId]) {
      r.users[clientId].lat = null;
      r.users[clientId].lng = null;
      io.to(room).emit('user:left', { room, clientId });
    }
  });

  socket.on('location', (payload) => {
    payload = payload || {};
    const lat = payload.lat;
    const lng = payload.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    const clientId = socket.data.clientId;
    if (!clientId) return;

    socket.data.sharingRooms.forEach(room => {
      applyLocationUpdate(clientId, room, lat, lng);
    });
  });

  socket.on('room:rename', (payload) => {
    payload = payload || {};
    const room = sanitizeRoom(payload.room);
    const clientId = socket.data.clientId;
    if (!isCreator(room, clientId)) return;
    const newName = String(payload.name || '').trim().slice(0, 30);
    if (!newName) return;
    rooms[room].name = newName;
    io.to(room).emit('room:info', { room, name: newName });
  });

  socket.on('room:setPassword', (payload) => {
    payload = payload || {};
    const room = sanitizeRoom(payload.room);
    const clientId = socket.data.clientId;
    if (!isCreator(room, clientId)) return;
    const newPass = String(payload.password || '');
    if (!newPass) return;
    rooms[room].password = newPass;
    socket.emit('room:passwordChanged', { room, password: newPass });
  });

  socket.on('room:close', (payload) => {
    payload = payload || {};
    const room = sanitizeRoom(payload.room);
    const clientId = socket.data.clientId;
    if (!isCreator(room, clientId)) return;
    io.to(room).emit('room:closed', { room });
    const socketsInRoom = io.sockets.adapter.rooms.get(room);
    if (socketsInRoom) {
      socketsInRoom.forEach(sid => {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.leave(room);
          s.data.rooms.delete(room);
          s.data.sharingRooms.delete(room);
        }
      });
    }
    delete rooms[room];
    console.log('Grupo cerrado: ' + room);
  });

  socket.on('disconnect', () => {
    markOffline(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor de ubicaciones escuchando en puerto ' + PORT);
  console.log('Abrí http://localhost:' + PORT + ' en el navegador');
  console.log('=================================================');
});
    
