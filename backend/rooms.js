// rooms.js
// إدارة حالة الغرف في الذاكرة — بدون قاعدة بيانات، لأن اللعبة مؤقتة وبدون حسابات

const rooms = new Map(); // code -> room object
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون أحرف ملتبسة (O/0, I/1)
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000; // نحذف الغرفة بعد 5 دقائق فارغة تماماً

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(hostSocketId, hostName) {
  const code = generateRoomCode();
  const room = {
    code,
    hostId: hostSocketId,
    phase: "lobby", // lobby | dealing | discussion | voting | final | ended
    players: new Map(), // socketId -> { id, name, connected, cards, isKiller, isEliminated }
    displays: new Set(), // socketId set لعملاء شاشة العرض
    round: 0,
    createdAt: Date.now(),
    emptyTimer: null,
  };
  room.players.set(hostSocketId, makePlayer(hostSocketId, hostName));
  rooms.set(code, room);
  return room;
}

function makePlayer(id, name) {
  return {
    id,
    name: (name || "لاعب").slice(0, 20),
    connected: true,
    cards: [],
    revealedCard: null,
    isKiller: false,
    isEliminated: false,
  };
}

function getRoom(code) {
  return rooms.get((code || "").toUpperCase());
}

function joinRoomAsPlayer(code, socketId, name) {
  const room = getRoom(code);
  if (!room) return { error: "الغرفة غير موجودة" };
  if (room.phase !== "lobby") return { error: "اللعبة بدأت بالفعل، لا يمكن الانضمام الآن" };
  if (room.players.size >= 12) return { error: "الغرفة ممتلئة" };
  clearEmptyTimer(room);
  room.players.set(socketId, makePlayer(socketId, name));
  return { room };
}

function joinRoomAsDisplay(code, socketId) {
  const room = getRoom(code);
  if (!room) return { error: "الغرفة غير موجودة" };
  clearEmptyTimer(room);
  room.displays.add(socketId);
  return { room };
}

function removeSocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) {
      const player = room.players.get(socketId);
      player.connected = false;
      // نحذف اللاعب فعلياً لو ما زالت اللعبة بمرحلة الانتظار
      if (room.phase === "lobby") {
        room.players.delete(socketId);
      }
      maybeScheduleCleanup(room);
      return room;
    }
    if (room.displays.has(socketId)) {
      room.displays.delete(socketId);
      maybeScheduleCleanup(room);
      return room;
    }
  }
  return null;
}

function maybeScheduleCleanup(room) {
  const hasConnectedPlayers = [...room.players.values()].some((p) => p.connected);
  if (!hasConnectedPlayers && room.displays.size === 0) {
    clearEmptyTimer(room);
    room.emptyTimer = setTimeout(() => rooms.delete(room.code), EMPTY_ROOM_TTL_MS);
  }
}

function clearEmptyTimer(room) {
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

// الحالة العامة المسموح للجميع رؤيتها (لاعبين + شاشة العرض)
function getPublicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isEliminated: p.isEliminated,
      revealedCard: p.revealedCard, // فقط الكارت المكشوف، أبداً باقي الكروت أو isKiller
    })),
  };
}

// الحالة الخاصة للاعب معين — تضيف كروته السرية فقط له
function getPrivateStateFor(room, socketId) {
  const me = room.players.get(socketId);
  return {
    ...getPublicState(room),
    you: me
      ? { id: me.id, name: me.name, cards: me.cards, isKiller: me.isKiller }
      : null,
  };
}

export {
  rooms,
  createRoom,
  getRoom,
  joinRoomAsPlayer,
  joinRoomAsDisplay,
  removeSocket,
  getPublicState,
  getPrivateStateFor,
};
