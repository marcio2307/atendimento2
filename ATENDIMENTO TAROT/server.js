// server.js - Chat + Reconexão por UID + Exclusão de mensagens
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7
});

// ===== Alerta por e-mail (igual ao seu) =====
const ALERT_TO = "marciodoxosse@gmail.com";
const ALERT_FROM = "Cartomantes Online <cartomantesonline2023@gmail.com>";
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: "cartomantesonline2023@gmail.com", pass: "gicv uzho xcvh yjkj" },
});
async function sendEmail({ subject, text, html }) {
  try {
    await transporter.sendMail({
      from: ALERT_FROM, to: ALERT_TO, subject, text,
      html: html || (text ? `<p>${text}</p>` : undefined),
    });
  } catch (err) { console.error("Falha ao enviar e-mail:", err); }
}

app.use(express.static(__dirname));

// ====== Estado por sala ======
const rooms = new Map();
function getState(room) {
  if (!rooms.has(room)) {
    rooms.set(room, {
      queue: [],
      attendantId: null,
      attendantUid: null,
      clientId: null,
      clientUid: null,
      timer: { running: false, elapsedSec: 0, startedAt: null },
      notifiedUIDs: new Map(),
      grace: { // tolerância de desconexão/reload
        attTimeout: null,
        cliTimeout: null,
        ms: 90_000 // 90s de tolerância para reconectar
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
  io.to(room).emit("timer_state", { running: st.timer.running, elapsedSec: st.timer.elapsedSec });
}
function pair(attendantSocket, clientSocket) {
  const room = attendantSocket.data.room;
  const st = getState(room);
  st.attendantId = attendantSocket.id;
  st.attendantUid = attendantSocket.data.uid;
  st.clientId = clientSocket.id;
  st.clientUid = clientSocket.data.uid;
  clientSocket.emit("paired");
  attendantSocket.emit("paired");
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
  if (!cli) { updateQueueSize(room); return false; }
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
  st.timer = { running: false, elapsedSec: 0, startedAt: null };
  if (st.grace.attTimeout) { clearTimeout(st.grace.attTimeout); st.grace.attTimeout = null; }
  if (st.grace.cliTimeout) { clearTimeout(st.grace.cliTimeout); st.grace.cliTimeout = null; }
  if (aId && io.sockets.sockets.has(aId)) io.to(aId).emit("conversation_ended", { reason });
  if (cId && io.sockets.sockets.has(cId)) io.to(cId).emit("conversation_ended", { reason });
  updateQueueSize(room);
}

// ====== Timer ======
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
  const delta = Math.round((Date.now() - (st.timer.startedAt || Date.now())) / 1000);
  st.timer.elapsedSec += Math.max(0, delta);
  st.timer.running = false;
  st.timer.startedAt = null;
  sendTimerState(room);
}

// ====== Socket.IO ======
io.on("connection", (socket) => {
  socket.data.role = "cliente";
  socket.data.room = "main";
  socket.data.uid = null;

  // Registro + reconexão por UID
  socket.on("register", ({ role, room, uid }) => {
    socket.data.role = (String(role).toLowerCase() === "atendente") ? "atendente" : "cliente";
    socket.data.room = room || "main";
    socket.data.uid = uid || null;
    socket.join(socket.data.room);

    const st = getState(socket.data.room);

    // Cancelar qualquer timeout de “queda” se reconectar com o mesmo UID
    if (socket.data.role === "atendente") {
      if (st.attendantUid && uid === st.attendantUid) {
        st.attendantId = socket.id; // reanexa
        if (st.grace.attTimeout) { clearTimeout(st.grace.attTimeout); st.grace.attTimeout = null; }
        if (st.clientId) socket.emit("paired");
        sendTimerState(socket.data.room);
        updateQueueSize(socket.data.room);
        return;
      }
    } else { // cliente
      if (st.clientUid && uid === st.clientUid) {
        st.clientId = socket.id; // reanexa
        if (st.grace.cliTimeout) { clearTimeout(st.grace.cliTimeout); st.grace.cliTimeout = null; }
        if (st.attendantId) socket.emit("paired");
        sendTimerState(socket.data.room);
        updateQueueSize(socket.data.room);
        return;
      }
    }

    // Fluxo normal
    if (socket.data.role === "cliente") {
      // se já há cliente pareado, não entra na fila de novo
      if (st.clientId && st.clientUid && uid === st.clientUid) {
        st.clientId = socket.id;
        socket.emit("paired");
        sendTimerState(socket.data.room);
        return;
      }
      if (!st.queue.includes(socket.id)) st.queue.push(socket.id);
      io.to(socket.data.room).emit("queue_join");
      updateQueueSize(socket.data.room);

      // Anti-spam por UID: 15 min
      const now = Date.now();
      const TTL = 15 * 60 * 1000;
      const key = uid || `${socket.id}`;
      const last = st.notifiedUIDs.get(key);
      if (!last || now - last > TTL) {
        st.notifiedUIDs.set(key, now);
        const sala = socket.data.room;
        const assunto = `Novo cliente aguardando · sala ${sala}`;
        const horario = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
        const texto = `Um novo cliente entrou na fila.\nSala: ${sala}\nUID: ${key}\nData/Hora: ${horario}\n`;
        sendEmail({ subject: assunto, text: texto, html: `
          <h2>Novo cliente aguardando</h2>
          <p><strong>Sala:</strong> ${sala}</p>
          <p><strong>UID:</strong> ${key}</p>
          <p><strong>Horário:</strong> ${horario}</p>` });
      }
    } else {
      updateQueueSize(socket.data.room);
    }
  });

  socket.on("next_in_queue", () => {
    if (socket.data.role !== "atendente") return;
    pairNext(socket);
  });

  socket.on("leave_queue", ({ uid, room }) => {
    const r = room || socket.data.room;
    const st = getState(r);
    st.queue = st.queue.filter(id => id !== socket.id);
    updateQueueSize(r);
  });

  socket.on("queue_sync", ({ room }) => updateQueueSize(room || socket.data.room));

  socket.on("end_conversation", () => unpair(socket.data.room, "ended"));

  // ====== Mensagens ======
  socket.on("chat_message", ({ text, id }) => {
    const room = socket.data.room;
    if (typeof text !== "string" || !text.trim()) return;
    const st = getState(room);
    const from = socket.data.role === "atendente" ? "attendant" : "client";
    const targetId = (from === "attendant") ? st.clientId : st.attendantId;
    if (targetId && io.sockets.sockets.get(targetId)) {
      io.to(targetId).emit("chat_message", { from, text, id });
    }
  });

  socket.on("chat_image", ({ dataUrl, alt, id }) => {
    const room = socket.data.room;
    if (!dataUrl || typeof dataUrl !== "string") return;
    const st = getState(room);
    const from = socket.data.role === "atendente" ? "attendant" : "client";
    const targetId = (from === "attendant") ? st.clientId : st.attendantId;
    if (targetId && io.sockets.sockets.get(targetId)) {
      io.to(targetId).emit("chat_image", { from, dataUrl, alt, id });
    }
  });

  socket.on("chat_audio", ({ dataUrl, durSec, id }) => {
    const room = socket.data.room;
    if (!dataUrl || typeof dataUrl !== "string") return;
    const st = getState(room);
    const from = socket.data.role === "atendente" ? "attendant" : "client";
    const targetId = (from === "attendant") ? st.clientId : st.attendantId;
    if (targetId && io.sockets.sockets.get(targetId)) {
      io.to(targetId).emit("chat_audio", { from, dataUrl, durSec, id });
    }
  });

  // recibo de leitura
  socket.on("message_seen", ({ id }) => {
    const room = socket.data.room;
    const st = getState(room);
    const toId = (socket.id === st.attendantId) ? st.clientId : st.attendantId;
    if (toId && io.sockets.sockets.get(toId)) {
      io.to(toId).emit("message_seen", { id });
    }
  });

  // digitando / gravando
  socket.on("typing", ({ isTyping }) => {
    const room = socket.data.room;
    const st = getState(room);
    const from = socket.data.role === "atendente" ? "attendant" : "client";
    const toId = (from === "attendant") ? st.clientId : st.attendantId;
    if (toId && io.sockets.sockets.get(toId)) {
      io.to(toId).emit("typing", { from, isTyping: !!isTyping });
    }
  });
  socket.on("recording", ({ isRecording }) => {
    const room = socket.data.room;
    const st = getState(room);
    const from = socket.data.role === "atendente" ? "attendant" : "client";
    const toId = (from === "attendant") ? st.clientId : st.attendantId;
    if (toId && io.sockets.sockets.get(toId)) {
      io.to(toId).emit("recording", { from, isRecording: !!isRecording });
    }
  });

  // ===== Exclusão de mensagens =====
  socket.on("delete_message", ({ id }) => {
    if (!id) return;
    const room = socket.data.room;
    const st = getState(room);
    // envia para ambos (remover dos dois lados)
    if (st.attendantId) io.to(st.attendantId).emit("delete_message", { id });
    if (st.clientId) io.to(st.clientId).emit("delete_message", { id });
  });

  // ===== Timer =====
  socket.on("timer_start", () => startTimer(socket.data.room));
  socket.on("timer_stop", () => stopTimer(socket.data.room));

  // ===== Desconexão com tolerância (não encerrar no reload) =====
  socket.on("disconnect", () => {
    const room = socket.data.room;
    const st = getState(room);
    // tirar da fila, se estava apenas aguardando
    st.queue = st.queue.filter(id => id !== socket.id);
    updateQueueSize(room);

    // Se era pareado, inicia tolerância sem encerrar
    if (socket.id === st.attendantId) {
      if (st.grace.attTimeout) clearTimeout(st.grace.attTimeout);
      st.grace.attTimeout = setTimeout(() => {
        // se não reconectou com o mesmo UID
        if (!st.attendantId || !io.sockets.sockets.has(st.attendantId)) {
          unpair(room, "attendant_left");
        }
      }, st.grace.ms);
    } else if (socket.id === st.clientId) {
      if (st.grace.cliTimeout) clearTimeout(st.grace.cliTimeout);
      st.grace.cliTimeout = setTimeout(() => {
        if (!st.clientId || !io.sockets.sockets.has(st.clientId)) {
          unpair(room, "client_left");
        }
      }, st.grace.ms);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server rodando na porta", PORT));
