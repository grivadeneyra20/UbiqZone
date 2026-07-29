const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const SERVER_VERSION = 'v7-persistencia-rastro-lugares';
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

// =====================================================================
// 1) PERSISTENCIA EN DISCO
// ---------------------------------------------------------------------
// Antes todo vivia solo en memoria: si el servidor se reiniciaba (o se
// dormia, como pasa en los planes gratuitos), se perdian los grupos, las
// claves, quien era el administrador y las fotos. Ahora se guarda todo en
// un archivo JSON y se vuelve a cargar al arrancar.
// =====================================================================

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'ubiqzone-data.json');

let rooms = {};
let photos = {};

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('Sin datos guardados todavia (arranque limpio).');
      return;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    rooms = data.rooms || {};
    photos = data.photos || {};

    // Al arrancar nadie esta conectado, y limpiamos rastros viejos.
    Object.values(rooms).forEach(r => {
      if (!r.places) r.places = [];
      Object.values(r.users || {}).forEach(u => {
        u.online = false;
        u.track = pruneTrack(u.track);
        if (!u.inPlaces) u.inPlaces = {};
      });
    });

    console.log('Datos recuperados: ' + Object.keys(rooms).length + ' grupo(s), ' +
      Object.keys(photos).length + ' foto(s).');
  } catch (e) {
    console.log('No se pudo leer el archivo de datos (' + e.message + '), arranco limpio.');
    rooms = {};
    photos = {};
  }
}

let saveTimer = null;
let savePending = false;

function saveSoon() {
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (savePending) saveNow();
  }, 3000);
}

function saveNow() {
  savePending = false;
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ rooms, photos }), 'utf8');
    fs.renameSync(tmp, DATA_FILE); // escritura atomica: nunca queda a medias
  } catch (e) {
    console.log('ERROR guardando datos: ' + e.message);
  }
}

// Guardado de respaldo cada 2 minutos y al apagar el servidor.
setInterval(() => { if (savePending) saveNow(); }, 120000);
['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    console.log('Apagando, guardando datos...');
    saveNow();
    process.exit(0);
  });
});

// =====================================================================
// Utilidades
// =====================================================================

function sanitizeRoom(room) {
  let r = String(room || '').trim().toUpperCase();
  r = r.replace(/[^A-Z0-9_-]/g, '');
  r = r.slice(0, 20);
  return r || 'FAMILIA';
}

function isCreator(room, clientId) {
  return !!(rooms[room] && rooms[room].creatorId === clientId);
}

function sanitizePhoto(photo) {
  if (typeof photo !== 'string') return null;
  if (!photo.startsWith('data:image/')) return null;
  if (photo.length > 4000000) return null; // ~4 MB de texto base64
  return photo;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function broadcastCount(room) {
  if (!rooms[room]) return;
  const count = Object.values(rooms[room].users).filter(u => u.online).length;
  io.to(room).emit('count', { room, count });
}

// =====================================================================
// 3) RASTRO DE LAS ULTIMAS 24 HORAS
// ---------------------------------------------------------------------
// De cada persona guardamos los puntos por donde paso. Solo agregamos un
// punto si se movio de verdad (mas de 25 m), para no llenar el archivo
// con el temblor normal del GPS.
// =====================================================================

const TRACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TRACK_MIN_DIST_M = 25;
const TRACK_MAX_POINTS = 700;

function pruneTrack(track) {
  if (!Array.isArray(track)) return [];
  const limit = Date.now() - TRACK_MAX_AGE_MS;
  let out = track.filter(p => p && p.ts >= limit);
  if (out.length > TRACK_MAX_POINTS) out = out.slice(out.length - TRACK_MAX_POINTS);
  return out;
}

function pushTrackPoint(user, lat, lng, ts) {
  if (!Array.isArray(user.track)) user.track = [];
  const last = user.track[user.track.length - 1];
  if (last && distanceMeters(last.lat, last.lng, lat, lng) < TRACK_MIN_DIST_M) {
    last.ts = ts; // sigue en el mismo sitio: solo actualizamos la hora
    return;
  }
  user.track.push({ lat, lng, ts });
  user.track = pruneTrack(user.track);
}

// =====================================================================
// 4) LUGARES Y AVISOS DE LLEGADA (geocercas)
// ---------------------------------------------------------------------
// Cada grupo puede marcar lugares ("Casa", "Colegio"). Cuando alguien
// entra o sale del circulo, avisamos a todo el grupo.
// =====================================================================

function checkPlaces(room, user) {
  const r = rooms[room];
  if (!r || !Array.isArray(r.places) || r.places.length === 0) return;
  if (!user.inPlaces) user.inPlaces = {};

  r.places.forEach(place => {
    const d = distanceMeters(user.lat, user.lng, place.lat, place.lng);
    const inside = d <= (place.radius || 150);
    const wasInside = !!user.inPlaces[place.id];

    if (inside === wasInside) return;
    user.inPlaces[place.id] = inside;

    io.to(room).emit('place:event', {
      room,
      clientId: user.clientId,
      name: user.name,
      placeId: place.id,
      placeName: place.name,
      type: inside ? 'arrived' : 'left',
      ts: Date.now()
    });
    console.log((inside ? 'LLEGO' : 'SALIO') + ': ' + user.name + ' -> ' + place.name + ' (' + room + ')');
  });
}

// =====================================================================
// Actualizacion de ubicacion
// =====================================================================

function applyLocationUpdate(clientId, room, lat, lng, name) {
  const r = rooms[room];
  if (!r || !r.users[clientId]) return false;
  const u = r.users[clientId];
  const now = Date.now();

  u.lat = lat;
  u.lng = lng;
  u.updatedAt = now;
  u.online = true;
  if (name) u.name = name;

  pushTrackPoint(u, lat, lng, now);
  checkPlaces(room, u);
  saveSoon();

  io.to(room).emit('user:update', {
    room,
    clientId,
    name: u.name,
    photo: u.photo || photos[clientId] || null,
    lat,
    lng,
    updatedAt: now,
    online: true
  });
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

// Para comprobar de un vistazo que el servidor esta vivo y actualizado.
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: SERVER_VERSION,
    grupos: Object.keys(rooms).length,
    fotos: Object.keys(photos).length
  });
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
  saveSoon();
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
        users: {},
        places: []
      };
      console.log('Grupo creado: ' + room + ' por ' + clientId);
    } else {
      if (r.password !== password) {
        socket.emit('join:denied', { room });
        return;
      }
      if (!r.places) r.places = [];
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
      online: true,
      track: existing ? pruneTrack(existing.track) : [],
      inPlaces: existing ? (existing.inPlaces || {}) : {}
    };

    const amCreator = isCreator(room, clientId);

    socket.emit('join:ok', { room, name: r.name, isCreator: amCreator });
    if (amCreator) {
      socket.emit('room:youAreAdmin', { room });
    }

    const usersList = Object.values(r.users)
      .filter(u => typeof u.lat === 'number' && typeof u.lng === 'number')
      .map(u => ({
        clientId: u.clientId,
        name: u.name,
        photo: u.photo || photos[u.clientId] || null,
        lat: u.lat,
        lng: u.lng,
        updatedAt: u.updatedAt,
        online: u.online
      }));
    socket.emit('users:init', { room, users: usersList });
    socket.emit('places:init', { room, places: r.places });

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
    saveSoon();
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
    saveSoon();
  });

  // --- Rastro: se pide solo cuando alguien quiere verlo ---
  socket.on('track:get', (payload) => {
    payload = payload || {};
    const room = sanitizeRoom(payload.room);
    if (!socket.data.rooms.has(room)) return;
    const r = rooms[room];
    const target = String(payload.clientId || '');
    if (!r || !r.users[target]) return;

    const points = pruneTrack(r.users[target].track);
    r.users[target].track = points;
    socket.emit('track:data', {
      room,
      clientId: target,
      name: r.users[target].name,
      points
    });
  });

  // --- Lugares (geocercas) ---
  socket.on('place:add', (payload) => {
    payload = payload || {};
    const room = sanitizeRoom(payload.room);
    if (!socket.data.rooms.has(room)) return;
    const r = rooms[room];
    if (!r) return;
    if (!Array.isArray(r.places)) r.places = [];
    if (r.places.length >= 20) return;

    const name = String(payload.name || 'Lugar').trim().slice(0, 30) || 'Lugar';
    const lat = payload.lat;
    const lng = payload.lng;
    let radius = parseInt(payload.radius, 10);
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    if (!radius || radius < 50) radius = 150;
    if (radius > 2000) radius = 2000;

    r.places.push({
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, lat, lng, radius
    });

    io.to(room).emit('places:init', { room, places: r.places });
    saveSoon();
  });

  socket.on('place:remove', (payload) => {
    payload = payload || {};
    const room = sanitizeRoom(payload.room);
    if (!socket.data.rooms.has(room)) return;
    const r = rooms[room];
    if (!r || !Array.isArray(r.places)) return;
    const id = String(payload.id || '');
    r.places = r.places.filter(p => p.id !== id);
    Object.values(r.users).forEach(u => { if (u.inPlaces) delete u.inPlaces[id]; });
    io.to(room).emit('places:init', { room, places: r.places });
    saveSoon();
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
      saveSoon();
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
    saveSoon();
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
    saveSoon();
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
    saveSoon();
  });

  socket.on('disconnect', () => {
    markOffline(socket);
  });
});

loadState();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor de ubicaciones escuchando en puerto ' + PORT);
  console.log('Datos guardados en: ' + DATA_FILE);
  console.log('=================================================');
});



    
