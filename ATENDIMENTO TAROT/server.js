// server.js - COMPLETO CORRIGIDO PARA RENDER
// Chat + Reconexão UID + Exclusão + Rotas funcionando

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);

// ================= SOCKET =================
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7
});

// ================= EMAIL =================
const ALERT_TO = "marciodoxosse@gmail.com";
const ALERT_FROM = "Cartomantes Online <cartomantesonline2023@gmail.com>";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: "cartomantesonline2023@gmail.com",
    pass: "gicv uzho xcvh yjkj"
  }
});

async function sendEmail({ subject, text, html }) {
  try {
    await transporter.sendMail({
      from: ALERT_FROM,
      to: ALERT_TO,
      subject,
      text,
      html: html || `<p>${text}</p>`
    });
  } catch (err) {
    console.error("Erro email:", err.message);
  }
}

// ================= STATIC =================

// arquivos públicos
app.use(express.static(__dirname));

// ROOT -> index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// encerrado.html
app.get("/encerrado.html", (req, res) => {
  res.sendFile(path.join(__dirname, "encerrado.html"));
});

// ================= ESTADO =================
const rooms = new Map();

function getState(room) {
  if (!rooms.has(room)) {
    rooms.set(room, {
      queue: [],
      attendantId: null,
      attendantUid: null,
      clientId: null,
      clientUid: null,

      timer: {
        running: false,
        elapsedSec: 0,
        startedAt: null
      },

      notifiedUIDs: new Map(),

      grace: {
        attTimeout: null,
        cliTimeout: null,
        ms: 90000
      }
    });
  }

  return rooms.get(room);
}

function updateQueueSize(room) {
  const st = getState(room);
  io.to(room).emit("queue_size", { size: st.queue.length });
}

function cleanQueue(room) {
  const st = getState(room);
  st.queue = st.queue.filter(id => io.sockets.sockets.has(id));
}

function sendTimerState(room) {
  const st = getState(room);

  io.to(room).emit("timer_state", {
    running: st.timer.running,
    elapsedSec: st.timer.elapsedSec
  });
}

// ================= PAREAR =================
function pair(attendantSocket, clientSocket) {
  const room = attendantSocket.data.room;
  const st = getState(room);

  st.attendantId = attendantSocket.id;
  st.attendantUid = attendantSocket.data.uid;

  st.clientId = clientSocket.id;
  st.clientUid = clientSocket.data.uid;

  attendantSocket.emit("paired");
  clientSocket.emit("paired");

  sendTimerState(room);
  updateQueueSize(room);
}

function pairNext(attendantSocket) {
  const room = attendantSocket.data.room;
  const st = getState(room);

  cleanQueue(room);

  if (!st.queue.length) return false;

  const nextClientId = st.queue.shift();
  const cli = io.sockets.sockets.get(nextClientId);

  if (!cli) {
    updateQueueSize(room);
    return false;
  }

  pair(attendantSocket, cli);
  return true;
}

function unpair(room, reason = "ended") {
  const st = getState(room);

  const aId = st.attendantId;
  const cId = st.clientId;

  st.attendantId = null;
  st.clientId = null;
  st.attendantUid = null;
  st.clientUid = null;

  st.timer = {
    running: false,
    elapsedSec: 0,
    startedAt: null
  };

  if (st.grace.attTimeout) clearTimeout(st.grace.attTimeout);
  if (st.grace.cliTimeout) clearTimeout(st.grace.cliTimeout);

  st.grace.attTimeout = null;
  st.grace.cliTimeout = null;

  if (aId) io.to(aId).emit("conversation_ended", { reason });
  if (cId) io.to(cId).emit("conversation_ended", { reason });

  updateQueueSize(room);
}

// ================= TIMER =================
function startTimer(room) {
  const st = getState(room);

  if (st.timer.running) return;

  st.timer.running = true;
  st.timer.startedAt = Date.now();

  sendTimerState(room);
}

function stopTimer(room) {
  const st = getState(room);

  if (!st.timer.running) return;

  const delta = Math.round(
    (Date.now() - st.timer.startedAt) / 1000
  );

  st.timer.elapsedSec += delta;
  st.timer.running = false;
  st.timer.startedAt = null;

  sendTimerState(room);
}

// ================= SOCKET =================
io.on("connection", socket => {

  socket.data.role = "cliente";
  socket.data.room = "main";
  socket.data.uid = null;

  // ================= REGISTER =================
  socket.on("register", ({ role, room, uid }) => {

    socket.data.role =
      String(role).toLowerCase() === "atendente"
        ? "atendente"
        : "cliente";

    socket.data.room = room || "main";
    socket.data.uid = uid || null;

    socket.join(socket.data.room);

    const st = getState(socket.data.room);

    // ===== reconectar atendente
    if (
      socket.data.role === "atendente" &&
      st.attendantUid &&
      uid === st.attendantUid
    ) {
      st.attendantId = socket.id;

      if (st.grace.attTimeout)
        clearTimeout(st.grace.attTimeout);

      st.grace.attTimeout = null;

      socket.emit("paired");

      sendTimerState(socket.data.room);
      updateQueueSize(socket.data.room);

      return;
    }

    // ===== reconectar cliente
    if (
      socket.data.role === "cliente" &&
      st.clientUid &&
      uid === st.clientUid
    ) {
      st.clientId = socket.id;

      if (st.grace.cliTimeout)
        clearTimeout(st.grace.cliTimeout);

      st.grace.cliTimeout = null;

      socket.emit("paired");

      sendTimerState(socket.data.room);
      updateQueueSize(socket.data.room);

      return;
    }

    // ===== NOVO CLIENTE
    if (socket.data.role === "cliente") {

      if (!st.queue.includes(socket.id))
        st.queue.push(socket.id);

      io.to(socket.data.room).emit("queue_join");

      updateQueueSize(socket.data.room);

      const now = Date.now();
      const key = uid || socket.id;
      const TTL = 15 * 60 * 1000;

      const last = st.notifiedUIDs.get(key);

      if (!last || now - last > TTL) {
        st.notifiedUIDs.set(key, now);

        sendEmail({
          subject: "Novo cliente aguardando",
          text: `Sala: ${socket.data.room}`
        });
      }

    } else {
      updateQueueSize(socket.data.room);
    }

  });

  // ================= FILA =================
  socket.on("next_in_queue", () => {
    if (socket.data.role !== "atendente") return;
    pairNext(socket);
  });

  socket.on("leave_queue", () => {
    const st = getState(socket.data.room);

    st.queue = st.queue.filter(id => id !== socket.id);

    updateQueueSize(socket.data.room);
  });

  socket.on("queue_sync", () => {
    updateQueueSize(socket.data.room);
  });

  // ================= CHAT =================
  socket.on("chat_message", ({ text, id, reply }) => {

    const st = getState(socket.data.room);

    const from =
      socket.data.role === "atendente"
        ? "attendant"
        : "client";

    const toId =
      from === "attendant"
        ? st.clientId
        : st.attendantId;

    if (toId)
      io.to(toId).emit("chat_message", {
        from,
        text,
        id,
        reply
      });
  });

  socket.on("chat_image", data => {
    const st = getState(socket.data.room);

    const from =
      socket.data.role === "atendente"
        ? "attendant"
        : "client";

    const toId =
      from === "attendant"
        ? st.clientId
        : st.attendantId;

    if (toId)
      io.to(toId).emit("chat_image", {
        from,
        ...data
      });
  });

  socket.on("chat_audio", data => {
    const st = getState(socket.data.room);

    const from =
      socket.data.role === "atendente"
        ? "attendant"
        : "client";

    const toId =
      from === "attendant"
        ? st.clientId
        : st.attendantId;

    if (toId)
      io.to(toId).emit("chat_audio", {
        from,
        ...data
      });
  });

  socket.on("delete_message", ({ id }) => {
    const st = getState(socket.data.room);

    if (st.attendantId)
      io.to(st.attendantId).emit("delete_message", { id });

    if (st.clientId)
      io.to(st.clientId).emit("delete_message", { id });
  });

  socket.on("typing", ({ isTyping }) => {
    const st = getState(socket.data.room);

    const from =
      socket.data.role === "atendente"
        ? "attendant"
        : "client";

    const toId =
      from === "attendant"
        ? st.clientId
        : st.attendantId;

    if (toId)
      io.to(toId).emit("typing", {
        from,
        isTyping
      });
  });

  socket.on("recording", ({ isRecording }) => {
    const st = getState(socket.data.room);

    const from =
      socket.data.role === "atendente"
        ? "attendant"
        : "client";

    const toId =
      from === "attendant"
        ? st.clientId
        : st.attendantId;

    if (toId)
      io.to(toId).emit("recording", {
        from,
        isRecording
      });
  });

  socket.on("message_seen", ({ id }) => {
    const st = getState(socket.data.room);

    const toId =
      socket.id === st.attendantId
        ? st.clientId
        : st.attendantId;

    if (toId)
      io.to(toId).emit("message_seen", { id });
  });

  // ================= TIMER =================
  socket.on("timer_start", () => {
    startTimer(socket.data.room);
  });

  socket.on("timer_stop", () => {
    stopTimer(socket.data.room);
  });

  // ================= ENCERRAR =================
  socket.on("end_conversation", () => {
    unpair(socket.data.room, "ended");
  });

  // ================= DISCONNECT =================
  socket.on("disconnect", () => {

    const st = getState(socket.data.room);

    st.queue = st.queue.filter(id => id !== socket.id);

    updateQueueSize(socket.data.room);

    if (socket.id === st.attendantId) {

      st.grace.attTimeout = setTimeout(() => {
        if (!io.sockets.sockets.has(st.attendantId))
          unpair(socket.data.room, "attendant_left");
      }, st.grace.ms);

    }

    if (socket.id === st.clientId) {

      st.grace.cliTimeout = setTimeout(() => {
        if (!io.sockets.sockets.has(st.clientId))
          unpair(socket.data.room, "client_left");
      }, st.grace.ms);

    }

  });

});

// ================= START =================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Servidor online porta", PORT);
});
