const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const SERVER_VERSION = 'ultima-ubicacion-v6-fotos';
console.log('Versión del servidor: ' + SERVER_VERSION);

const app = express();
app.use(cors());
// Las fotos de perfil viajan como texto base64 dentro del JSON, asi que
// subimos el limite (por defecto express solo acepta 100kb).
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 90000,
  // Mismo motivo: una foto base64 puede pesar cientos de KB.
  maxHttpBufferSize: 5e6
});

// Fotos de perfil por persona (clientId -> base64). Asi la foto sobrevive
// aunque el usuario se salga del grupo y vuelva a entrar.
const photos = {};

function sanitizePhoto(photo) {
  if (typeof photo !== 'string') return null;
  if (!photo.startsWith('data:image/')) return null;
  if (photo.length > 4000000) return null; // ~4 MB de texto base64
  return photo;
}

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
    photo: r.users[clientId].photo || photos[clientId] || null,
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
    // Foto de perfil: si viene una nueva la guardamos; si no, usamos la
    // ultima que nos haya mandado esta persona.
    const incomingPhoto = sanitizePhoto(payload.photo);
    if (incomingPhoto) photos[clientId] = incomingPhoto;
    const photo = photos[clientId] || null;

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
      photo: photo,
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

    const usersList = Object.values(r.users)
      .filter(u => typeof u.lat === 'number' && typeof u.lng === 'number')
      .map(u => Object.assign({}, u, { photo: u.photo || photos[u.clientId] || null }));
    socket.emit('users:init', { room, users: usersList });

    // Avisamos al resto del grupo (con foto) para que me vean sin esperar
    // a que se mueva el GPS.
    const me = r.users[clientId];
    if (typeof me.lat === 'number' && typeof me.lng === 'number') {
      socket.to(room).emit('user:update', {
        room,
        clientId,
        name: me.name,
        photo: me.photo || null,
        lat: me.lat,
        lng: me.lng,
        updatedAt: me.updatedAt,
        online: true
      });
    }

    broadcastCount(room);
  });

  // Cambio de foto o nombre desde el panel de perfil, sin tener que
  // volver a entrar al grupo.
  socket.on('profile:update', (payload) => {
    payload = payload || {};
    const clientId = socket.data.clientId;
    if (!clientId) return;

    const newPhoto = sanitizePhoto(payload.photo);
    if (newPhoto) photos[clientId] = newPhoto;
    const newName = String(payload.name || '').trim().slice(0, 30);

    socket.data.rooms.forEach(room => {
      const r = rooms[room];
      if (!r || !r.users[clientId]) return;
      if (newPhoto) r.users[clientId].photo = newPhoto;
      if (newName) r.users[clientId].name = newName;

      const u = r.users[clientId];
      io.to(room).emit('user:update', {
        room,
        clientId,
        name: u.name,
        photo: u.photo || null,
        lat: u.lat,
        lng: u.lng,
        updatedAt: u.updatedAt || Date.now(),
        online: true
      });
    });
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

    
