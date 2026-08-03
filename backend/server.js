import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  createRoom,
  getRoom,
  joinRoomAsPlayer,
  joinRoomAsDisplay,
  removeSocket,
  getPublicState,
  getPrivateStateFor,
} from "./rooms.js";

const PORT = process.env.PORT || 3001;
// حط رابط الفرونت إند بتاعك على Vercel هنا بعد النشر
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : "*";

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.get("/", (_req, res) => res.send("Killer/Money game server is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] },
});

// يبعث لكل لاعب نسخته الخاصة + لكل شاشات العرض النسخة العامة
function broadcastRoomState(room) {
  for (const player of room.players.values()) {
    if (player.connected) {
      io.to(player.id).emit("state_update", getPrivateStateFor(room, player.id));
    }
  }
  const publicState = getPublicState(room);
  for (const displayId of room.displays) {
    io.to(displayId).emit("state_update", publicState);
  }
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ name } = {}, callback) => {
    const room = createRoom(socket.id, name);
    socket.join(room.code);
    callback?.({ code: room.code });
    broadcastRoomState(room);
  });

  socket.on("join_room", ({ code, name, type } = {}, callback) => {
    const result =
      type === "display"
        ? joinRoomAsDisplay(code, socket.id)
        : joinRoomAsPlayer(code, socket.id, name);

    if (result.error) {
      callback?.({ error: result.error });
      return;
    }
    socket.join(result.room.code);
    callback?.({ code: result.room.code });
    broadcastRoomState(result.room);
  });

  socket.on("leave_room", ({ code } = {}) => {
    const room = getRoom(code);
    if (!room) return;
    removeSocket(socket.id);
    socket.leave(code);
    broadcastRoomState(room);
  });

  socket.on("disconnect", () => {
    const room = removeSocket(socket.id);
    if (room) broadcastRoomState(room);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
