import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import {
  createRoom,
  getRoom,
  requestJoin,
  approveJoin,
  rejectJoin,
  kickPlayer,
  joinRoomAsDisplay,
  removeSocket,
  getPublicState,
  getPrivateStateFor,
  dealCards,
  startVoting,
  castVote,
  allVotesIn,
  resolveVoting,
  castFinalChoice,
  finalChoicesReady,
  resolveFinal,
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

// يبعث لكل لاعب نسخته الخاصة + لكل شاشات العرض النسخة العامة + تنبيه بسيط للمنتظرين موافقة
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
  for (const pendingId of room.pending.keys()) {
    io.to(pendingId).emit("pending_update", { code: room.code });
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
    if (type === "display") {
      const result = joinRoomAsDisplay(code, socket.id);
      if (result.error) return callback?.({ error: result.error });
      socket.join(result.room.code);
      callback?.({ code: result.room.code });
      broadcastRoomState(result.room);
      return;
    }

    const result = requestJoin(code, socket.id, name);
    if (result.error) {
      callback?.({ error: result.error });
      return;
    }
    socket.join(result.room.code);
    callback?.({ code: result.room.code, pending: true });
    broadcastRoomState(result.room);
  });

  socket.on("approve_join", ({ code, targetId } = {}, callback) => {
    const room = getRoom(code);
    if (!room) return callback?.({ error: "الغرفة غير موجودة" });
    if (room.hostId !== socket.id) return callback?.({ error: "بس المضيف يقدر يوافق" });
    const result = approveJoin(room, targetId);
    if (result?.error) return callback?.(result);
    callback?.({ ok: true });
    broadcastRoomState(room);
  });

  socket.on("reject_join", ({ code, targetId } = {}, callback) => {
    const room = getRoom(code);
    if (!room) return callback?.({ error: "الغرفة غير موجودة" });
    if (room.hostId !== socket.id) return callback?.({ error: "بس المضيف يقدر يرفض" });
    rejectJoin(room, targetId);
    io.to(targetId).emit("join_rejected", { code });
    callback?.({ ok: true });
    broadcastRoomState(room);
  });

  socket.on("kick_player", ({ code, targetId } = {}, callback) => {
    const room = getRoom(code);
    if (!room) return callback?.({ error: "الغرفة غير موجودة" });
    const result = kickPlayer(room, targetId, socket.id);
    if (result?.error) return callback?.(result);
    io.to(targetId).emit("kicked", { code });
    callback?.({ ok: true });
    broadcastRoomState(room);
  });

  socket.on("leave_room", ({ code } = {}) => {
    const room = getRoom(code);
    if (!room) return;
    removeSocket(socket.id);
    socket.leave(code);
    broadcastRoomState(room);
  });

  socket.on("start_game", ({ code } = {}, callback) => {
    const room = getRoom(code);
    if (!room) return callback?.({ error: "الغرفة غير موجودة" });
    if (room.hostId !== socket.id) return callback?.({ error: "بس المضيف يقدر يبدأ اللعبة" });
    const connectedCount = [...room.players.values()].filter((p) => p.connected).length;
    if (connectedCount < 3) return callback?.({ error: "تحتاج 3 لاعبين على الأقل" });
    dealCards(room);
    callback?.({ ok: true });
    broadcastRoomState(room);
  });

  socket.on("start_voting", ({ code } = {}, callback) => {
    const room = getRoom(code);
    if (!room) return callback?.({ error: "الغرفة غير موجودة" });
    const result = startVoting(room, socket.id);
    if (result.error) return callback?.(result);
    callback?.({ ok: true });
    broadcastRoomState(room);
  });

  socket.on("cast_vote", ({ code, targetId } = {}, callback) => {
    const room = getRoom(code);
    if (!room) return callback?.({ error: "الغرفة غير موجودة" });
    const result = castVote(room, socket.id, targetId);
    if (result.error) return callback?.(result);
    callback?.({ ok: true });
    broadcastRoomState(room);
    if (allVotesIn(room)) {
      resolveVoting(room);
      broadcastRoomState(room);
    }
  });

  socket.on("cast_final_choice", ({ code, choice } = {}, callback) => {
    const room = getRoom(code);
    if (!room) return callback?.({ error: "الغرفة غير موجودة" });
    const result = castFinalChoice(room, socket.id, choice);
    if (result.error) return callback?.(result);
    callback?.({ ok: true });
    broadcastRoomState(room);
    if (finalChoicesReady(room)) {
      resolveFinal(room);
      broadcastRoomState(room);
    }
  });

  socket.on("disconnect", () => {
    const room = removeSocket(socket.id);
    if (room) broadcastRoomState(room);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
