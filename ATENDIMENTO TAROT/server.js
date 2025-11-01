// server.js — Chat Tarot + GPT-4o-mini (com logs de depuração)
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// =============== CONFIGURAÇÃO DO GPT ===============
const openai = new OpenAI({
  apiKey: "SXQxtibo1GIgaiwuAya2sHfyfxoEA9K4djDp0sqXHo_pYNWenO"
});

// =============== EMAIL DE ALERTA ===============
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: "cartomantesonline2023@gmail.com",
    pass: "gicv uzho xcvh yjkj"
  }
});

async function sendEmail(subject, html) {
  try {
    await transporter.sendMail({
      from: "Cartomantes Online <cartomantesonline2023@gmail.com>",
      to: "marciodoxosse@gmail.com",
      subject,
      html
    });
  } catch (e) {
    console.log("⚠️ Erro ao enviar e-mail:", e.message);
  }
}

// =============== ROTAS ESTÁTICAS ===============
app.use(express.static(__dirname));

// =============== GERENCIAMENTO DE SALAS ===============
const rooms = new Map();

function getState(room) {
  if (!rooms.has(room)) {
    rooms.set(room, {
      attendantId: null,
      clientId: null,
      queue: []
    });
  }
  return rooms.get(room);
}

// =============== CONEXÃO SOCKET.IO ===============
io.on("connection", (socket) => {
  socket.data.role = "cliente";
  socket.data.room = "main";

  socket.on("register", ({ role, room }) => {
    socket.data.role = (role || "cliente").toLowerCase();
    socket.data.room = room || "main";
    socket.join(socket.data.room);
    const st = getState(socket.data.room);

    if (socket.data.role === "atendente") {
      st.attendantId = socket.id;
      console.log(`🎧 Atendente conectado na sala ${socket.data.room}`);
    } else {
      st.queue.push(socket.id);
      console.log(`🙋 Cliente entrou na fila da sala ${socket.data.room}`);
      sendEmail("Novo cliente aguardando",
        `<b>Sala:</b> ${socket.data.room}<br><b>Horário:</b> ${new Date().toLocaleString("pt-BR")}`);
    }

    io.to(socket.data.room).emit("queue_size", { size: st.queue.length });
  });

  // =============== ENVIO DE MENSAGEM ===============
  socket.on("chat_message", async ({ text }) => {
    const room = socket.data.room;
    const st = getState(room);
    const from = socket.data.role;
    const targetId = (from === "atendente") ? st.clientId : st.attendantId;

    // Envia mensagem ao outro lado
    if (targetId && io.sockets.sockets.get(targetId)) {
      io.to(targetId).emit("chat_message", { from, text });
    }

    // ======== GPT responde quando CLIENTE fala ========
    if (from === "cliente" && text.trim()) {
      console.log("💬 Cliente:", text);

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "Você é um atendente espiritual e cartomante empático. Responda com sabedoria, gentileza e foco em tarot." },
            { role: "user", content: text }
          ],
          temperature: 0.8
        });

        const reply = response.choices[0].message.content.trim();
        console.log("🔮 GPT respondeu:", reply);

        io.to(socket.id).emit("chat_message", {
          from: "atendente",
          text: reply
        });
      } catch (err) {
        console.error("❌ Erro ao chamar ChatGPT:", err.message);
        io.to(socket.id).emit("chat_message", {
          from: "atendente",
          text: "⚠️ Erro ao consultar o oráculo. Tente novamente em instantes."
        });
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Usuário desconectado:", socket.id);
  });
});

// =============== INÍCIO DO SERVIDOR ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("🚀 Servidor ativo na porta", PORT));
