const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const SERVER_VERSION = 'ultima-ubicacion-v5';

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 20000,
});

// Salas en memoria:
// { roomCode: { name, password, creatorId (clientId persistente), users: { clientId: {clientId,name,lat,lng,updatedAt,online} } } }
const rooms = {};

function sanitizeRoom(room) {
  return String(room || 'FAMILIA')
    .trim()
    .toUpperCase()
    .slice(0, 20)
    .replace(/[^A-Z0-9_-]/g, '') || 'FAMILIA';
}

function isCreator(room, clientId) {
  return !!(rooms[room] && rooms[room].creatorId === clientId);
}

function broadcastCount(room) {
  if (!rooms[room]) return;
  const onlineCount = Object.values(rooms[room].users).filter((u) => u.online).length;
  io.to(room).emit('count', { room: room, count: onlineCount });
}

// Al desconectarse (wifi caída, pantalla apagada mucho tiempo, teléfono apagado, etc.)
// NO borramos a la persona: la marcamos offline pero conservamos su última ubicación
// conocida, para que en el mapa se vea grisada con "visto hace X" en vez de desaparecer.
function markOffline(socket) {
  const clientId = socket.data.clientId;
  if (!clientId) return;
  socket.data.rooms.forEach((room) => {
    const r = rooms[room];
    if (!r || !r.users[clientId]) return;
    r.users[clientId].online = false;
    io.to(room).emit('user:offline', {
      room: room,
      clientId: clientId,
      updatedAt: r.users[clientId].updatedAt,
    });
    broadcastCount(room);
  });
}

io.on('connection', (socket) => {
  socket.data.rooms = new Set();
  socket.data.sharingRooms = new Set();
  socket.data.clientId = null;
  console.log('Conexión nueva:', socket.id);

  socket.on('join', (data) => {
    try {
      const clientId = (data && data.clientId) ? String(data.clientId).slice(0, 60) : socket.id;
      const name = (data && data.name) ? String(data.name).slice(0, 30) : 'Anónimo';
      const room = sanitizeRoom(data && data.room);
      const password = data && data.password ? String(data.password).slice(0, 50) : '';
      const groupName = (data && data.groupName) ? String(data.groupName).trim().slice(0, 30) : room;

      socket.data.clientId = clientId;
      console.log('join recibido de', clientId, '-> sala:', room);

      if (!rooms[room]) {
        rooms[room] = { name: groupName || room, password, creatorId: clientId, users: {} };
        console.log('sala nueva creada:', room, 'admin:', clientId);
      } else if (rooms[room].password !== password) {
        console.log('clave incorrecta para sala:', room);
        socket.emit('join:denied', { room: room, reason: 'password' });
        return;
      }

      socket.data.rooms.add(room);
      socket.join(room);

      const existing = rooms[room].users[clientId];
      rooms[room].users[clientId] = {
        clientId,
        name,
        lat: existing ? existing.lat : null,
        lng: existing ? existing.lng : null,
        updatedAt: existing ? existing.updatedAt : Date.now(),
        online: true,
      };

      socket.emit('join:ok', {
        room,
        name: rooms[room].name,
        isCreator: isCreator(room, clientId),
      });

      socket.emit('users:init', {
        room: room,
        users: Object.values(rooms[room].users).filter((u) => u.lat !== null),
      });

      broadcastCount(room);
    } catch (err) {
      console.error('Error en join:', err);
    }
  });

  socket.on('room:startSharing', (data) => {
    const room = sanitizeRoom(data && data.room);
    if (!socket.data.rooms.has(room)) return;
    socket.data.sharingRooms.add(room);
    console.log(socket.data.clientId, 'activó GPS en', room);
  });

  // Desactivación EXPLÍCITA por el usuario: se oculta del mapa por completo (privacidad),
  // a diferencia de una desconexión involuntaria que deja la última ubicación visible.
  socket.on('room:stopSharing', (data) => {
    const room = sanitizeRoom(data && data.room);
    socket.data.sharingRooms.delete(room);
    const r = rooms[room];
    const clientId = socket.data.clientId;
    if (r && r.users[clientId]) {
      r.users[clientId].lat = null;
      r.users[clientId].lng = null;
      io.to(room).emit('user:left', { room: room, clientId: clientId });
    }
    console.log(clientId, 'desactivó GPS en', room);
  });

  socket.on('location', (data) => {
    const { lat, lng } = data || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    const clientId = socket.data.clientId;
    if (!clientId) return;

    socket.data.sharingRooms.forEach((room) => {
      const r = rooms[room];
      if (!r || !r.users[clientId]) return;
      const u = r.users[clientId];
      u.lat = lat;
      u.lng = lng;
      u.updatedAt = Date.now();
      u.online = true;
      const payload = Object.assign({ room: room }, u);
      socket.to(room).volatile.emit('user:update', payload);
      socket.emit('user:update', payload);
    });
  });

  socket.on('room:rename', (data) => {
    const room = sanitizeRoom(data && data.room);
    if (!room || !rooms[room] || !isCreator(room, socket.data.clientId)) return;
    const newName = data && data.name ? String(data.name).trim().slice(0, 30) : '';
    if (!newName) return;
    rooms[room].name = newName;
    io.to(room).emit('room:info', { room: room, name: newName });
  });

  socket.on('room:setPassword', (data) => {
    const room = sanitizeRoom(data && data.room);
    if (!room || !rooms[room] || !isCreator(room, socket.data.clientId)) return;
    const newPass = data && typeof data.password === 'string' ? data.password.slice(0, 50) : '';
    rooms[room].password = newPass;
    socket.emit('room:passwordChanged', { room: room, password: newPass });
  });

  socket.on('room:close', (data) => {
    const room = sanitizeRoom(data && data.room);
    if (!room || !rooms[room] || !isCreator(room, socket.data.clientId)) return;
    io.to(room).emit('room:closed', { room: room });
    const socketsInRoom = io.sockets.adapter.rooms.get(room);
    if (socketsInRoom) {
      Array.from(socketsInRoom).forEach((sid) => {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.leave(room);
          s.data.rooms.delete(room);
          s.data.sharingRooms.delete(room);
        }
      });
    }
    delete rooms[room];
    console.log('sala cerrada por el admin:', room);
  });

  socket.on('disconnect', () => {
    console.log('Desconexión:', socket.id, '(clientId ' + socket.data.clientId + ')');
    markOffline(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('=================================');
  console.log('Versión del servidor: ' + SERVER_VERSION);
  console.log('Servidor de ubicaciones escuchando en puerto ' + PORT);
  console.log('Abrí http://localhost:' + PORT + ' en el navegador');
  console.log('=================================');
});
