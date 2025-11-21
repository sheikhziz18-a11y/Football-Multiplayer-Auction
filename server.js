// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");

// Load players (ensure shuffled_players.json exists in repo root)
let MASTER_PLAYERS = JSON.parse(fs.readFileSync("shuffled_players.json", "utf8"));

const app = express();
const server = http.createServer(app);

// Enable CORS for socket.io (Render friendly)
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static("public"));

/* ===========================
   GAME STATE (PER ROOM)
=========================== */
let rooms = {};

/* ===========================
   UTILITIES
=========================== */

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function pushLog(room, type, text) {
  // log entries are objects {type, text}
  room.log.push({ type, text });
  // keep log size reasonable
  if (room.log.length > 1000) room.log.splice(0, room.log.length - 1000);
}

/* Timer reset helper */
function resetTimers(room) {
  if (room.initialTimer) clearInterval(room.initialTimer);
  if (room.bidTimer) clearInterval(room.bidTimer);
  room.initialTimer = null;
  room.bidTimer = null;
  room.initialTimeLeft = 60;
  room.bidTimeLeft = 30;
  room.skippedPlayers = []; // skip list per-auction
}

function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  // send the whole players object (keys are socket IDs)
  io.to(roomId).emit("roomState", {
    players: room.players,
    hostId: room.hostId,
    currentPlayer: room.currentPlayer,
    currentPosition: room.currentPosition,
    currentBid: room.currentBid,
    currentBidder: room.currentBidder,
    initialTimeLeft: room.initialTimeLeft,
    bidTimeLeft: room.bidTimeLeft,
    spinInProgress: room.spinInProgress,
    auctionActive: room.auctionActive,
    log: room.log
  });
}

/* Picks and removes a random player for a given position from room.availablePlayers */
function pickRandomPlayerByPosition(room, position) {
  const candidates = room.availablePlayers.filter(p => p.position === position);
  if (candidates.length === 0) return null;
  const idx = Math.floor(Math.random() * candidates.length);
  const player = candidates[idx];
  // remove selected player from available pool for this room
  room.availablePlayers = room.availablePlayers.filter(p => p !== player);
  return player;
}

/* ===========================
   TIMERS AND AUCTION HELPERS
=========================== */

function startInitialTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.initialTimer) clearInterval(room.initialTimer);
  room.initialTimeLeft = 60;
  room.initialTimer = setInterval(() => {
    room.initialTimeLeft--;
    if (room.initialTimeLeft <= 0) {
      clearInterval(room.initialTimer);
      room.initialTimer = null;
      room.auctionActive = false;
      endCurrentPlayer(roomId);
    }
    broadcastRoomState(roomId);
  }, 1000);
}

function startBidTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.bidTimer) clearInterval(room.bidTimer);
  room.bidTimeLeft = 30;
  room.bidTimer = setInterval(() => {
    room.bidTimeLeft--;
    if (room.bidTimeLeft <= 0) {
      clearInterval(room.bidTimer);
      room.bidTimer = null;
      room.auctionActive = false;
      endCurrentPlayer(roomId);
    }
    broadcastRoomState(roomId);
  }, 1000);
}

/* Finalize current player: assign to winner or mark unsold. NO auto-spin. */
function endCurrentPlayer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const player = room.currentPlayer;
  const bidderId = room.currentBidder;

  if (bidderId && player) {
    // If bidder still present in players list, assign; otherwise mark unsold
    if (!room.players[bidderId]) {
      pushLog(room, "info", `Winner disconnected; ${player.name} unsold`);
    } else {
      room.players[bidderId].team.push({
        name: player.name,
        price: room.currentBid
      });
      room.players[bidderId].balance -= room.currentBid;
      pushLog(room, "win", `${room.players[bidderId].name} won ${player.name} for ${room.currentBid}M`);
    }
  } else if (player) {
    pushLog(room, "unsold", `${player.name} was unsold`);
  }

  // Reset auction state for this player (host must manually spin next)
  room.currentPlayer = null;
  room.currentBid = 0;
  room.currentBidder = null;
  room.currentPosition = null;
  room.auctionActive = false;
  resetTimers(room);
  broadcastRoomState(roomId);
}

/* Spin wheel: server picks index and position, emits wheelResult, sets player after animation */
function spinWheel(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.availablePlayers.length === 0) {
    pushLog(room, "info", "No players left in pool");
    broadcastRoomState(roomId);
    return;
  }

  // Begin spin
  room.spinInProgress = true;
  room.auctionActive = false;
  room.currentPlayer = null;
  room.currentPosition = null;
  room.currentBid = 0;
  room.currentBidder = null;
  resetTimers(room);
  broadcastRoomState(roomId);

  // positions array; must match client label order
  const positions = ["GK", "CB", "RB", "LB", "RW", "CF", "AM", "LW", "CM", "DM"];
  const chosenIndex = Math.floor(Math.random() * positions.length);
  const position = positions[chosenIndex];

  // pick player (removes from pool)
  const player = pickRandomPlayerByPosition(room, position);

  // inform clients which slice to animate to
  io.to(roomId).emit("wheelResult", { index: chosenIndex, position });

  // after wheel animation (2.5s), reveal player and start timers
  setTimeout(() => {
    room.spinInProgress = false;
    if (!player) {
      pushLog(room, "info", `No players left for position ${position}.`);
      broadcastRoomState(roomId);
      return;
    }

    room.currentPlayer = player;
    room.currentPosition = position;
    room.currentBid = 0;
    room.currentBidder = null;
    room.auctionActive = true;
    room.skippedPlayers = []; // clear skip list for this new player
    pushLog(room, "spin", `Position: ${position} → ${player.name} (${player.basePrice}M)`);
    broadcastRoomState(roomId);
    startInitialTimer(roomId);
  }, 2500);
}

/* ===========================
   SOCKET HANDLERS
=========================== */

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  /* ---- Create Room ---- */
  socket.on("createRoom", (name) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      hostId: socket.id,
      players: {},
      availablePlayers: JSON.parse(JSON.stringify(MASTER_PLAYERS)),
      currentPlayer: null,
      currentPosition: null,
      currentBid: 0,
      currentBidder: null,
      initialTimeLeft: 60,
      bidTimeLeft: 30,
      initialTimer: null,
      bidTimer: null,
      auctionActive: false,
      spinInProgress: false,
      log: [],
      skippedPlayers: []
    };

    rooms[roomId].players[socket.id] = {
      name,
      balance: 1000,
      team: [],
      active: true,
      disconnected: false
    };

    socket.join(roomId);
    socket.emit("roomJoined", roomId);
    pushLog(rooms[roomId], "info", `${name} (host) created the room`);
    broadcastRoomState(roomId);
  });

  /* ---- Join Room (with reconnect-by-name) ---- */
  socket.on("joinRoom", ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit("error", "Room not found");

    // If socket already has an entry (rare), return
    if (room.players[socket.id]) return socket.emit("roomJoined", roomId);

    // Try to find an existing player with the same name
    let existingPid = null;
    for (const pid in room.players) {
      if (room.players[pid] && room.players[pid].name === name) {
        existingPid = pid;
        break;
      }
    }

    if (existingPid) {
      // restore previous player's data onto this new socket id
      const prev = room.players[existingPid];

      room.players[socket.id] = {
        name: prev.name,
        balance: prev.balance,
        team: prev.team,
        active: true,
        disconnected: false
      };

      // remove old socket key if different
      if (existingPid !== socket.id) {
        try { delete room.players[existingPid]; } catch (e) { /* ignore */ }
      }

      socket.join(roomId);
      socket.emit("roomJoined", roomId);
      pushLog(room, "info", `${name} rejoined the room`);
      broadcastRoomState(roomId);
      return;
    }

    // New player
    if (Object.keys(room.players).length >= 6) {
      return socket.emit("error", "Room is full");
    }

    room.players[socket.id] = {
      name,
      balance: 1000,
      team: [],
      active: true,
      disconnected: false
    };

    socket.join(roomId);
    socket.emit("roomJoined", roomId);
    pushLog(room, "info", `${name} joined the room`);
    broadcastRoomState(roomId);
  });

  /* ---- Start Spin (Host Only) ---- */
  socket.on("startSpin", (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (socket.id !== room.hostId) return;
    if (room.spinInProgress || room.auctionActive) return;
    spinWheel(roomId);
  });

  /* ---- Bid ---- */
  socket.on("bid", (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.auctionActive || !room.currentPlayer) return;
    if (!room.players[socket.id]) return;

    // If player has skipped this round, reject
    if (room.skippedPlayers && room.skippedPlayers.includes(socket.id)) {
      socket.emit("error", "You skipped this round and cannot bid again for this player.");
      return;
    }

    const playerObj = room.players[socket.id];

    let nextBid =
      room.currentBid === 0
        ? room.currentPlayer.basePrice
        : room.currentBid < 200
        ? room.currentBid + 5
        : room.currentBid + 10;

    if (playerObj.balance < nextBid) {
      socket.emit("error", "Insufficient balance");
      return;
    }

    // First bid: stop initial timer and start bid timer
    if (room.currentBid === 0) {
      if (room.initialTimer) { clearInterval(room.initialTimer); room.initialTimer = null; }
      startBidTimer(roomId);
    } else {
      // reset bid timer
      room.bidTimeLeft = 30;
    }

    room.currentBid = nextBid;
    room.currentBidder = socket.id;
    pushLog(room, "info", `${playerObj.name} bid ${nextBid}M for ${room.currentPlayer.name}`);
    broadcastRoomState(roomId);
  });

  /* ---- Skip ---- */
  socket.on("skip", (roomId) => {
    const room = rooms[roomId];
    if (!room || !room.auctionActive || !room.currentPlayer) return;
    if (!room.players[socket.id]) return;

    if (!room.skippedPlayers.includes(socket.id)) {
      room.skippedPlayers.push(socket.id);
      pushLog(room, "skip", `${room.players[socket.id].name} skipped ${room.currentPlayer.name}`);
    }

    // If everyone skipped -> end current player
    const totalPlayers = Object.keys(room.players).length;
    if (room.skippedPlayers.length === totalPlayers) {
      if (room.initialTimer) { clearInterval(room.initialTimer); room.initialTimer = null; }
      if (room.bidTimer) { clearInterval(room.bidTimer); room.bidTimer = null; }
      endCurrentPlayer(roomId);
    }

    broadcastRoomState(roomId);
  });

  /* ---- Disconnect ----
     Do NOT delete player data. Mark as disconnected/inactive.
     When they return with same name, joinRoom will restore them.
  */
  socket.on("disconnect", () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room) continue;
      if (room.players[socket.id]) {
        const name = room.players[socket.id].name;
        // mark inactive and disconnected
        room.players[socket.id].active = false;
        room.players[socket.id].disconnected = true;
        pushLog(room, "info", `${name} disconnected`);

        // Host left -> transfer host to first remaining player (if any)
        if (room.hostId === socket.id) {
          const remaining = Object.keys(room.players).filter(pid => pid !== socket.id);
          room.hostId = remaining.length ? remaining[0] : null;
          if (room.hostId && room.players[room.hostId]) {
            pushLog(room, "info", `${room.players[room.hostId].name} is now host`);
          }
        }

        broadcastRoomState(roomId);
      }
    }
  });
});

/* ===========================
   START SERVER
=========================== */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
