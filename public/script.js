// script.js (updated)
// connect
const socket = io();

/* ELEMENTS */
const loginPage = document.getElementById("loginPage");
const auctionPage = document.getElementById("auctionPage");

const createName = document.getElementById("createName");
const joinName = document.getElementById("joinName");
const joinRoomId = document.getElementById("joinRoomId");

const roomIdDisplay = document.getElementById("roomIdDisplay");
const startSpinBtn = document.getElementById("startSpinBtn");
const wheel = document.getElementById("wheel");
const wheelLabels = document.getElementById("wheelLabels");

const playerNameBox = document.getElementById("playerName");
const playerPosBox = document.getElementById("playerPos");
const playerBaseBox = document.getElementById("playerBase");

const initialTimerBox = document.getElementById("initialTimer");
const bidTimerBox = document.getElementById("bidTimer");

const bidBtn = document.getElementById("bidBtn");
const skipBtn = document.getElementById("skipBtn");

const logBox = document.getElementById("logBox");
const summaryList = document.getElementById("summaryList");

let currentRoom = null;
let myId = null;
let wheelRotation = 0;

// positions array must match server order
const POSITIONS = ["GK", "CB", "RB", "LB", "RW", "CF", "AM", "LW", "CM", "DM"];

/* CREATE / JOIN */
document.getElementById("createRoomBtn").onclick = () => {
  if (!createName.value) return alert("Enter your name");
  socket.emit("createRoom", createName.value);
};

document.getElementById("joinRoomBtn").onclick = () => {
  if (!joinName.value || !joinRoomId.value) return alert("Enter all fields");
  socket.emit("joinRoom", { roomId: joinRoomId.value.trim(), name: joinName.value });
};

/* SOCKET EVENTS */
socket.on("roomJoined", (roomId) => {
  currentRoom = roomId;
  joinAuctionPage(roomId);
});

socket.on("roomCreated", (roomId) => {
  if (!currentRoom) {
    currentRoom = roomId;
    joinAuctionPage(roomId);
  }
});

socket.on("roomState", (state) => {
  renderRoomState(state);
});

socket.on("wheelResult", ({ index, position }) => {
  animateWheelToIndex(index);
});

/* UI switch */
function joinAuctionPage(roomId) {
  loginPage.classList.add("hidden");
  auctionPage.classList.remove("hidden");
  roomIdDisplay.innerText = "Room ID — " + roomId;
}

/* Render state */
function renderRoomState(state) {
  if (!myId) myId = socket.id;

  // host controls
  startSpinBtn.style.display = (myId === state.hostId) ? "inline-block" : "none";

  // player card
  if (state.currentPlayer) {
    playerNameBox.innerText = state.currentPlayer.name || "Player Name";
    playerPosBox.innerText = "(" + (state.currentPosition || "") + ")";
    playerBaseBox.innerText = "Base Price: " + state.currentPlayer.basePrice + "M";
  } else {
    playerNameBox.innerText = "Player Name";
    playerPosBox.innerText = "(Position)";
    playerBaseBox.innerText = "Base Price";
  }

  // timers values
  const initialLeft = typeof state.initialTimeLeft === "number" ? state.initialTimeLeft : 60;
  const bidLeft = typeof state.bidTimeLeft === "number" ? state.bidTimeLeft : 30;

  initialTimerBox.innerText = initialLeft;
  bidTimerBox.innerText = bidLeft;

  // blinking effect when <5s (only opacity blink; no color change)
  toggleBlink(initialTimerBox, initialLeft < 5 && state.auctionActive && state.currentPlayer && state.currentBid === 0);
  toggleBlink(bidTimerBox, bidLeft < 5 && state.auctionActive && state.currentBid !== 0);

  // Bid button logic - also enforce skip prevention: if this client skipped, server puts them in skippedPlayers (server enforces) but we also can disable via checking players list
  if (!state.auctionActive || !state.currentPlayer) {
    bidBtn.disabled = true;
  } else {
    const me = state.players[myId];
    if (!me || me.team.length >= 11) {
      bidBtn.disabled = true;
    } else {
      let nextBid =
        state.currentBid === 0
          ? state.currentPlayer.basePrice
          : state.currentBid < 200
          ? state.currentBid + 5
          : state.currentBid + 10;
      bidBtn.innerText = "Bid " + nextBid + "M";

      // disable if current bidder is me or me doesn't have enough balance
      if (state.currentBidder === myId || me.balance < nextBid) {
        bidBtn.disabled = true;
      } else {
        // Additionally: disable if I have previously skipped (server enforces, but disable here defensively)
        // server keeps skippedPlayers list; if absent, we rely on server errors
        // We cannot access room.skippedPlayers here; so just allow until server rejects.
        bidBtn.disabled = false;
      }
    }
  }

  skipBtn.disabled = !(state.auctionActive && state.currentPlayer);

  // Logs: state.log is array of {type,text}
  renderLogs(state.log);

  // Summary
  renderSummary(state.players);
}

/* small helper to toggle blink class */
function toggleBlink(el, shouldBlink) {
  if (shouldBlink) el.classList.add("blink");
  else el.classList.remove("blink");
}

/* Logs rendering */
function renderLogs(logArray) {
  logBox.innerHTML = "";
  if (!Array.isArray(logArray)) return;
  logArray.slice(-300).forEach(entry => {
    // entry can be {type,text} or a simple string (backward compat)
    let type = "info", text = "";
    if (typeof entry === "string") { text = entry; type = "info"; }
    else { type = entry.type || "info"; text = entry.text || ""; }

    const d = document.createElement("div");
    d.className = "log-entry " + (type === "unsold" ? "unsold" : (type === "skip" ? "skip" : (type === "spin" ? "spin" : (type === "win" ? "win" : "info"))));
    // small stroke but not heavy, so we keep text normal with slight font-weight
    d.style.fontWeight = (type === "win" ? "600" : "500");
    d.textContent = text;
    logBox.appendChild(d);
  });
  logBox.scrollTop = logBox.scrollHeight;
}

/* Summary rendering (click to expand teams) */
function renderSummary(players) {
  summaryList.innerHTML = "";
  for (let id in players) {
    const p = players[id];
    const div = document.createElement("div");
    div.className = "summary-player";
    const balanceTxt = `${p.balance}M`;
    const teamCountTxt = `${p.team.length}/11`;
    div.innerHTML = `<div><b>${p.name}</b> — Balance: ${balanceTxt} — Players: ${teamCountTxt}</div>
      <div class="player-team" id="team-${id}">${p.team.map(t => `${t.name} — ${t.price}M`).join("<br>")}</div>`;
    div.onclick = () => {
      const el = document.getElementById("team-" + id);
      if (el) el.classList.toggle("show");
    };
    summaryList.appendChild(div);
  }
}

/* BUTTON ACTIONS */
startSpinBtn.onclick = () => {
  if (!currentRoom) return alert("Room not set");
  socket.emit("startSpin", currentRoom);
  // wheel animation handled on receiving wheelResult
};

bidBtn.onclick = () => {
  if (!currentRoom) return alert("Not in a room");
  socket.emit("bid", currentRoom);
};

skipBtn.onclick = () => {
  if (!currentRoom) return alert("Not in a room");
  socket.emit("skip", currentRoom);
};

/* WHEEL LABELS & ANIMATION */
/* Build labels once */
function buildWheelLabels() {
  if (!wheelLabels) return;
  wheelLabels.innerHTML = "";
  const slices = POSITIONS.length;
  const radius = (wheel.clientWidth / 2) - 10;
  for (let i = 0; i < slices; i++) {
    const label = document.createElement("div");
    label.className = "slice-label";
    // compute angle for label center
    const angle = (i * (360 / slices)) + (360 / slices) / 2;
    // position them using transform
    label.style.transform = `rotate(${angle}deg) translate(${radius}px) rotate(${90}deg)`;
    label.textContent = POSITIONS[i];
    wheelLabels.appendChild(label);
  }
}

/* animate wheel to a given slice index (server chooses index) */
function animateWheelToIndex(index) {
  const slices = POSITIONS.length;
  const sliceAngle = 360 / slices;
  const targetAngle = index * sliceAngle + sliceAngle / 2;
  const rotations = 6;
  const finalAngle = rotations * 360 + (360 - targetAngle);
  wheel.style.transition = "transform 2.5s cubic-bezier(.25,.8,.25,1)";
  wheelRotation = finalAngle;
  wheel.style.transform = `rotate(${wheelRotation}deg)`;
  setTimeout(() => {
    wheel.style.transition = "";
    const normalized = wheelRotation % 360;
    wheelRotation = normalized;
    wheel.style.transform = `rotate(${wheelRotation}deg)`;
  }, 2600);
}

/* initialize labels after page load and on resize */
window.addEventListener("load", buildWheelLabels);
window.addEventListener("resize", buildWheelLabels);

/* Auto-join support (optional) */
(function tryAutoJoinFromQuery(){
  const params = new URLSearchParams(window.location.search);
  const r = params.get("room");
  const n = params.get("name");
  if (r && n) {
    joinRoomId.value = r;
    joinName.value = n;
    document.getElementById("joinRoomBtn").click();
  }
})();
