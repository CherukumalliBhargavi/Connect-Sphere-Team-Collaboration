"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem("cs_token") || "",
  user: null,
  authMode: "login",
  socket: null,
  roomId: "",
  localStream: null,
  screenStream: null,
  micOn: true,
  cameraOn: true,
  drawing: false,
  erasing: false,
  lastPoint: null,
  timerStart: null,
  timerInterval: null,
  peerConnections: new Map(),
  files: [],
  messages: []
};

const views = ["dashboard", "meeting", "chat", "whiteboard", "files"];
let toastTimeout;
let noteTimeout;

// ---------- Notifications ----------
function toast(message) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove("show"), 3000);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[ch]);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.message || data.error || `Request failed (${response.status})`);
  }
  return data;
}

// ---------- Authentication ----------
function setAuthMode(mode) {
  state.authMode = mode;
  const registering = mode === "register";

  $("loginTab").classList.toggle("active", !registering);
  $("registerTab").classList.toggle("active", registering);
  $("nameLabel").classList.toggle("hidden", !registering);
  $("authName").classList.toggle("hidden", !registering);
  $("authName").required = registering;
  $("authPassword").autocomplete = registering ? "new-password" : "current-password";

  $("authTitle").textContent = registering ? "Create your account" : "Welcome back!";
  $("authSubtitle").textContent = registering
    ? "Join your team and start collaborating."
    : "Sign in to continue to your workspace.";
  $("authSubmit").textContent = registering ? "Create account →" : "Sign in →";
  $("authError").textContent = "";
}

$("loginTab").addEventListener("click", () => setAuthMode("login"));
$("registerTab").addEventListener("click", () => setAuthMode("register"));

$("authForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = $("authEmail").value.trim().toLowerCase();
  const password = $("authPassword").value;
  const name = $("authName").value.trim();
  const registering = state.authMode === "register";

  if (registering && name.length < 2) {
    $("authError").textContent = "Please enter your name.";
    return;
  }
  if (password.length < 8) {
    $("authError").textContent = "Password must contain at least 8 characters.";
    return;
  }

  const button = $("authSubmit");
  button.disabled = true;
  button.textContent = "Please wait…";
  $("authError").textContent = "";

  try {
    const result = await api(
      registering ? "/api/auth/register" : "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify(registering
          ? { name, email, password }
          : { email, password })
      }
    );

    if (!result.token) {
      throw new Error("The server did not return a login token. Check the backend response.");
    }

    state.token = result.token;
    state.user = result.user || { name: name || email.split("@")[0], email };

    localStorage.setItem("cs_token", state.token);
    showApplication();
    connectSocket();
    toast(registering ? "Account created successfully!" : "Welcome back!");
  } catch (error) {
    $("authError").textContent = error.message ||
      "Unable to sign in. Check that your backend is running.";
  } finally {
    button.disabled = false;
    button.textContent = registering ? "Create account →" : "Sign in →";
  }
});

async function checkSession() {
  if (!state.token) {
    showAuth();
    return;
  }

  try {
    const result = await api("/api/me");
    state.user = result.user || result;
    showApplication();
    connectSocket();
  } catch {
    state.token = "";
    state.user = null;
    localStorage.removeItem("cs_token");
    showAuth();
  }
}

function showAuth() {
  $("authScreen").classList.remove("hidden");
  $("appShell").classList.add("hidden");
}

function showApplication() {
  $("authScreen").classList.add("hidden");
  $("appShell").classList.remove("hidden");

  const user = state.user || {};
  const name = user.name || user.username || user.email?.split("@")[0] || "Member";

  $("userName").textContent = name;
  $("userEmail").textContent = user.email || "Connected";
  $("userAvatar").textContent = name.charAt(0).toUpperCase();
  showView("dashboard");
}

$("logoutBtn").addEventListener("click", async () => {
  if (state.roomId) leaveRoom(false);
  if (state.socket) state.socket.disconnect();

  state.token = "";
  state.user = null;
  localStorage.removeItem("cs_token");
  showAuth();
  toast("You have signed out.");
});

// ---------- Navigation ----------
function showView(view) {
  if (!views.includes(view)) return;

  for (const name of views) {
    $(`${name}View`).classList.toggle("hidden", name !== view);
  }

  document.querySelectorAll("[data-view]").forEach((button) => {
    if (button.classList.contains("nav-link")) {
      button.classList.toggle("active", button.dataset.view === view);
    }
  });

  const titles = {
    dashboard: "Dashboard",
    meeting: "Meeting room",
    chat: "Team chat",
    whiteboard: "Whiteboard",
    files: "Shared files"
  };
  $("pageName").textContent = titles[view];

  if (view === "whiteboard") resizeBoard();
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

$("headerStartBtn").addEventListener("click", () => {
  showView("meeting");
  createRoom();
});

$("heroJoinBtn").addEventListener("click", () => {
  showView("meeting");
  $("roomCodeInput").focus();
});

$("tipsBtn").addEventListener("click", () => {
  toast("Tip: create a room and share its code with your teammates.");
});

// ---------- Theme ----------
function setTheme(dark) {
  document.body.classList.toggle("dark-mode", dark);
  $("themeBtn").textContent = dark ? "☀" : "☾";
  localStorage.setItem("cs_theme", dark ? "dark" : "light");
}

setTheme(localStorage.getItem("cs_theme") === "dark");

$("themeBtn").addEventListener("click", () => {
  setTheme(!document.body.classList.contains("dark-mode"));
});

// ---------- Notes and checklist ----------
const notesKey = () => `cs_notes_${state.user?.email || "guest"}`;

$("quickNotes").value = localStorage.getItem(notesKey()) || "";

$("quickNotes").addEventListener("input", () => {
  $("notesStatus").textContent = "Saving…";
  clearTimeout(noteTimeout);

  noteTimeout = setTimeout(() => {
    localStorage.setItem(notesKey(), $("quickNotes").value);
    $("notesStatus").textContent = "Saved on this device";
  }, 200);
});

$("clearNotes").addEventListener("click", () => {
  $("quickNotes").value = "";
  localStorage.removeItem(notesKey());
  $("notesStatus").textContent = "Notes cleared";
});

function updateChecklist() {
  const boxes = [...document.querySelectorAll("[data-check]")];

  boxes.forEach((box) => {
    const key = `cs_check_${state.user?.email || "guest"}_${box.dataset.check}`;
    box.checked = localStorage.getItem(key) === "true";
  });

  const completed = boxes.filter((box) => box.checked).length;
  const percent = Math.round(completed / Math.max(boxes.length, 1) * 100);

  $("checkText").textContent = `${completed} of ${boxes.length} completed`;
  $("checkPercent").textContent = `${percent}%`;
  $("checkBar").style.width = `${percent}%`;
}

document.querySelectorAll("[data-check]").forEach((box) => {
  box.addEventListener("change", () => {
    const key = `cs_check_${state.user?.email || "guest"}_${box.dataset.check}`;
    localStorage.setItem(key, String(box.checked));
    updateChecklist();
  });
});

// ---------- Socket.IO connection ----------
function connectSocket() {
  if (typeof io !== "function") {
    console.warn("Socket.IO client was not loaded.");
    return;
  }

  if (state.socket) {
    state.socket.disconnect();
  }

  state.socket = io({
    auth: { token: state.token }
  });

  state.socket.on("connect", () => {
    console.log("Connected to collaboration server.");
  });

  state.socket.on("connect_error", (error) => {
    console.error("Socket connection error:", error.message);
  });

  state.socket.on("room:joined", (data = {}) => {
    state.roomId = data.roomId || state.roomId;
    updateRoomUI();
  });

  state.socket.on("room:peer-joined", (data = {}) => {
    toast(`${data.name || "A teammate"} joined the room.`);
    updateParticipants(data.participants);
  });

  state.socket.on("room:peer-left", (data = {}) => {
    const peerId = data.socketId;
    if (peerId) removePeer(peerId);
    updateParticipants(data.participants);
  });

  state.socket.on("room:error", (data = {}) => {
    toast(data.message || "Unable to join that room.");
  });

  state.socket.on("chat:message", (message) => {
    renderMessage(message, false);
  });

  state.socket.on("whiteboard:draw", (data) => {
    drawRemoteLine(data);
  });

  state.socket.on("whiteboard:clear", () => {
    clearBoard(false);
  });

  state.socket.on("file:shared", (data) => {
    toast(`${data.name || "A file"} was shared by a teammate.`);
  });

  state.socket.on("rtc:signal", handleRtcSignal);
}

// ---------- Rooms ----------
function makeRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createRoom() {
  const code = makeRoomCode();
  $("roomCodeInput").value = code;
  joinRoom(code);
}

$("createRoomBtn").addEventListener("click", createRoom);

$("joinForm").addEventListener("submit", (event) => {
  event.preventDefault();
  joinRoom($("roomCodeInput").value.trim());
});

async function joinRoom(code) {
  if (!state.socket?.connected) {
    toast("Connecting to the server. Please try again in a moment.");
    return;
  }

  if (!code) {
    toast("Enter a room code first.");
    return;
  }

  try {
    await ensureMedia();

    if (state.roomId) leaveRoom(false);

    state.roomId = code;
    state.socket.emit("room:join", { roomId: code });
    $("meetingTitle").textContent = `Room ${code}`;
    $("chatRoomLabel").textContent = `Room ${code}`;
    $("currentRoomCode").textContent = code;
    $("meetingStatus").textContent = "Joining…";
    showView("meeting");

    startMeetingTimer();
    updateRoomUI();
  } catch (error) {
    toast(error.message || "Please allow camera and microphone access.");
  }
}

async function ensureMedia() {
  if (state.localStream) return state.localStream;

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera access requires HTTPS or localhost in a supported browser.");
  }

  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true
  });

  addVideoTile("local", state.localStream, "You");
  return state.localStream;
}

function addVideoTile(id, stream, name) {
  const grid = $("videoGrid");
  grid.querySelector(".video-placeholder")?.remove();

  let tile = document.querySelector(`[data-peer="${CSS.escape(id)}"]`);

  if (!tile) {
    tile = document.createElement("div");
    tile.className = "video-tile";
    tile.dataset.peer = id;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = id === "local";
    tile.appendChild(video);

    const label = document.createElement("div");
    label.className = "video-name";
    label.textContent = name;
    tile.appendChild(label);

    grid.appendChild(tile);
  }

  tile.querySelector("video").srcObject = stream;
}

function updateRoomUI() {
  $("currentRoomCode").textContent = state.roomId || "No room yet";
  $("meetingTitle").textContent = state.roomId ? `Room ${state.roomId}` : "Meeting preview";
  $("chatRoomLabel").textContent = state.roomId ? `Room ${state.roomId}` : "Join a meeting room to begin";
  $("meetingStatus").textContent = state.roomId ? "In meeting" : "Not connected";
  $("meetingStatus").classList.toggle("connected", Boolean(state.roomId));
}

$("copyRoomBtn").addEventListener("click", async () => {
  if (!state.roomId) {
    toast("Create or join a room first.");
    return;
  }

  try {
    await navigator.clipboard.writeText(state.roomId);
    toast("Room code copied!");
  } catch {
    toast(`Your room code is ${state.roomId}`);
  }
});

function startMeetingTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);

  state.timerStart = Date.now();
  state.timerInterval = setInterval(() => {
    if (!state.timerStart) return;
    const seconds = Math.floor((Date.now() - state.timerStart) / 1000);
    $("meetingTimer").textContent =
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
      `${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
}

function leaveRoom(showMessage = true) {
  if (state.socket && state.roomId) {
    state.socket.emit("room:leave");
  }

  for (const [peerId, pc] of state.peerConnections) {
    pc.close();
    removePeer(peerId);
  }
  state.peerConnections.clear();

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }

  if (state.screenStream) {
    state.screenStream.getTracks().forEach((track) => track.stop());
    state.screenStream = null;
  }

  state.roomId = "";
  state.timerStart = null;
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;

  $("meetingTimer").textContent = "00:00";
  $("videoGrid").innerHTML = `
    <div class="video-placeholder">
      <span class="placeholder-icon">▣</span>
      <strong>Your meeting starts here</strong>
      <p>Create or join a room to connect.</p>
    </div>`;

  updateRoomUI();
  updateParticipants([]);

  if (showMessage) toast("You left the meeting.");
}

$("leaveBtn").addEventListener("click", () => leaveRoom());

// ---------- Microphone and camera ----------
$("micBtn").addEventListener("click", async () => {
  try {
    if (!state.localStream) await ensureMedia();
    state.micOn = !state.micOn;
    state.localStream.getAudioTracks().forEach((track) => {
      track.enabled = state.micOn;
    });
    $("micBtn").classList.toggle("active", state.micOn);
  } catch (error) {
    toast(error.message);
  }
});

$("cameraBtn").addEventListener("click", async () => {
  try {
    if (!state.localStream) await ensureMedia();
    state.cameraOn = !state.cameraOn;
    state.localStream.getVideoTracks().forEach((track) => {
      track.enabled = state.cameraOn;
    });
    $("cameraBtn").classList.toggle("active", state.cameraOn);
  } catch (error) {
    toast(error.message);
  }
});

// ---------- Screen sharing ----------
$("screenBtn").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("Screen sharing is not supported in this browser.");
    return;
  }

  try {
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((track) => track.stop());
      state.screenStream = null;
      $("screenBtn").classList.remove("active");
      toast("Screen sharing stopped.");
      return;
    }

    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = state.screenStream.getVideoTracks()[0];

    if (state.localStream) {
      const sender = [...state.peerConnections.values()]
        .flatMap((pc) => pc.getSenders())
        .find((item) => item.track?.kind === "video");

      if (sender) await sender.replaceTrack(track);
    }

    addVideoTile("screen-preview", state.screenStream, "Your shared screen");
    $("screenBtn").classList.add("active");

    track.addEventListener("ended", () => {
      document.querySelector('[data-peer="screen-preview"]')?.remove();
      state.screenStream = null;
      $("screenBtn").classList.remove("active");
    });
  } catch (error) {
    toast(error.name === "NotAllowedError" ? "Screen sharing was cancelled." : error.message);
  }
});

// ---------- Participant list ----------
function updateParticipants(participants) {
  if (!Array.isArray(participants)) return;

  $("participantCount").textContent = participants.length;
  $("participantList").innerHTML = "";

  if (!participants.length) {
    $("participantList").innerHTML = '<p class="muted">No participant list available yet.</p>';
    return;
  }

  participants.forEach((participant) => {
    const name = typeof participant === "string"
      ? participant
      : participant.name || participant.email || "Participant";

    const item = document.createElement("div");
    item.className = "participant-item";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = name.charAt(0).toUpperCase();

    const label = document.createElement("span");
    label.textContent = name;

    item.append(avatar, label);
    $("participantList").appendChild(item);
  });
}

// ---------- Basic WebRTC signaling ----------
function createPeerConnection(peerId) {
  if (state.peerConnections.has(peerId)) {
    return state.peerConnections.get(peerId);
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  state.peerConnections.set(peerId, pc);

  state.localStream?.getTracks().forEach((track) => {
    pc.addTrack(track, state.localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      state.socket.emit("rtc:signal", {
        to: peerId,
        signal: { candidate: event.candidate }
      });
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream) addVideoTile(peerId, stream, "Teammate");
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) {
      removePeer(peerId);
    }
  };

  return pc;
}

async function handleRtcSignal(data = {}) {
  if (!data.from || !data.signal) return;

  try {
    const pc = createPeerConnection(data.from);
    const signal = data.signal;

    if (signal.candidate) {
      await pc.addIceCandidate(signal.candidate);
    } else if (signal.description) {
      await pc.setRemoteDescription(signal.description);

      if (signal.description.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        state.socket.emit("rtc:signal", {
          to: data.from,
          signal: { description: pc.localDescription }
        });
      }
    }
  } catch (error) {
    console.error("WebRTC signaling failed:", error);
  }
}

function removePeer(peerId) {
  const pc = state.peerConnections.get(peerId);
  if (pc) {
    pc.close();
    state.peerConnections.delete(peerId);
  }
  document.querySelector(`[data-peer="${CSS.escape(peerId)}"]`)?.remove();
}

// ---------- Real-time chat ----------
$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const text = $("chatInput").value.trim();
  if (!text) return;

  if (!state.roomId || !state.socket?.connected) {
    toast("Join a meeting room before sending team messages.");
    return;
  }

  state.socket.emit("chat:message", { roomId: state.roomId, text });
  renderMessage({
    text,
    name: state.user?.name || state.user?.email || "You",
    email: state.user?.email || "",
    timestamp: new Date().toISOString()
  }, true);

  $("chatInput").value = "";
});

function renderMessage(message, mine) {
  const empty = $("chatMessages").querySelector(".empty-state");
  empty?.remove();

  const item = document.createElement("div");
  item.className = `message${mine ? " mine" : ""}`;

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const timestamp = message.timestamp ? new Date(message.timestamp) : new Date();
  const time = Number.isNaN(timestamp.getTime())
    ? ""
    : timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  meta.textContent = `${message.name || message.email || "Teammate"} · ${time}`;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = message.text || "";

  item.append(meta, bubble);
  $("chatMessages").appendChild(item);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

// ---------- Collaborative whiteboard ----------
const canvas = $("whiteboard");
const ctx = canvas.getContext("2d");

function resizeBoard() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const ratio = window.devicePixelRatio || 1;
  const old = document.createElement("canvas");
  old.width = canvas.width;
  old.height = canvas.height;
  old.getContext("2d").drawImage(canvas, 0, 0);

  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (old.width && old.height) {
    ctx.drawImage(old, 0, 0, old.width, old.height,
      0, 0, rect.width, rect.height);
  }
}

window.addEventListener("resize", resizeBoard);
requestAnimationFrame(resizeBoard);

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function drawLine(from, to, color, size, erasing = false) {
  ctx.save();
  ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.restore();
}

canvas.addEventListener("pointerdown", (event) => {
  state.drawing = true;
  state.lastPoint = canvasPoint(event);
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.drawing || !state.lastPoint) return;

  const next = canvasPoint(event);
  const color = state.erasing ? "#ffffff" : $("penColor").value;
  const size = Number($("penSize").value) * (state.erasing ? 3 : 1);

  drawLine(state.lastPoint, next, color, size, state.erasing);

  if (state.socket?.connected && state.roomId && !state.erasing) {
    state.socket.emit("whiteboard:draw", {
      roomId: state.roomId,
      from: state.lastPoint,
      to: next,
      color,
      size
    });
  }

  state.lastPoint = next;
});

function stopDrawing() {
  state.drawing = false;
  state.lastPoint = null;
}

canvas.addEventListener("pointerup", stopDrawing);
canvas.addEventListener("pointercancel", stopDrawing);
canvas.addEventListener("lostpointercapture", stopDrawing);

function drawRemoteLine(data) {
  if (!data?.from || !data?.to) return;
  drawLine(data.from, data.to, data.color || "#6955e8", Number(data.size) || 3);
}

$("eraserBtn").addEventListener("click", () => {
  state.erasing = !state.erasing;
  $("eraserBtn").textContent = state.erasing ? "✎ Pen mode" : "⌫ Eraser";
  toast(state.erasing ? "Eraser selected." : "Pen selected.");
});

function clearBoard(notify = true) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (notify && state.socket?.connected && state.roomId) {
    state.socket.emit("whiteboard:clear", { roomId: state.roomId });
  }
}

$("clearBoardBtn").addEventListener("click", () => {
  clearBoard();
  toast("Whiteboard cleared.");
});

$("saveBoardBtn").addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = "connectsphere-whiteboard.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
  toast("Whiteboard image downloaded.");
});

// ---------- File selection ----------
$("filePicker").addEventListener("change", (event) => {
  const selected = [...event.target.files];

  selected.forEach((file) => {
    state.files.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      file
    });
  });

  renderFiles();
  event.target.value = "";
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderFiles() {
  $("fileCount").textContent =
    `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;

  const list = $("fileList");
  list.innerHTML = "";

  if (!state.files.length) {
    list.innerHTML = `
      <div class="empty-state">
        <span>📁</span><h3>No files selected yet</h3>
        <p>Choose files above to add them to this session.</p>
      </div>`;
    return;
  }

  state.files.forEach(({ id, file }) => {
    const item = document.createElement("div");
    item.className = "file-item";

    const symbol = document.createElement("div");
    symbol.className = "file-symbol";
    symbol.textContent = "▤";

    const info = document.createElement("div");
    info.className = "file-info";

    const name = document.createElement("strong");
    name.textContent = file.name;

    const size = document.createElement("span");
    size.textContent = formatBytes(file.size);

    info.append(name, size);

    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "↓";
    download.title = "Download this file";
    download.setAttribute("aria-label", `Download ${file.name}`);

    download.addEventListener("click", () => {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove this file";
    remove.setAttribute("aria-label", `Remove ${file.name}`);

    remove.addEventListener("click", () => {
      state.files = state.files.filter((entry) => entry.id !== id);
      renderFiles();
    });

    item.append(symbol, info, download, remove);
    list.appendChild(item);
  });
}

// ---------- Start ----------
updateChecklist();
checkSession();
