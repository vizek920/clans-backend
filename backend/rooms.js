// rooms.js
// إدارة حالة الغرف في الذاكرة — بدون قاعدة بيانات، لأن اللعبة مؤقتة وبدون حسابات

const rooms = new Map(); // code -> room object
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون أحرف ملتبسة (O/0, I/1)
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000; // نحذف الغرفة بعد 5 دقائق فارغة تماماً

const CARDS_PER_PLAYER = 4;
const MONEY_VALUES = [500, 1000, 2000, 5000, 7500, 10000, 15000, 25000, 40000, 60000, 100000];

function formatMoney(value) {
  return value.toLocaleString("en-US") + " $";
}

function randomMoneyValue() {
  return MONEY_VALUES[Math.floor(Math.random() * MONEY_VALUES.length)];
}

// كروت الجولة النهائية (٢٠ كارت يجهزها المضيف مسبقاً) — قيمة افتراضية لو المضيف ما جهزها بنفسه
const FINAL_DECK_SIZE = 20;
const FINAL_CARDS_TO_REVEAL = 6;

function generateDefaultFinalDeck() {
  const defaults = [
    20, 30, 50, 50, 100, 150, 200, 250, 300, 500, 500, 750, 1000, 1000, 1500, 2000, 2500, 3000, 5000, 10000,
  ];
  return defaults.map((value, i) => ({
    id: `c${i + 1}`,
    value,
    isKiller: i === 6 || i === 13, // كارتين قاتل افتراضياً بالمنتصف تقريباً
    label: i === 6 || i === 13 ? "القاتل" : null,
  }));
}


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
    hostName: (hostName || "المضيف").slice(0, 20),
    phase: "lobby", // lobby | discussion | voting | final | ended
    players: new Map(), // socketId -> { id, name, connected, cards, isKiller, isEliminated } — اللاعبين فقط، المضيف مو منهم
    displays: new Set(), // socketId set لعملاء شاشة العرض
    pending: new Map(), // socketId -> { id, name } بانتظار موافقة المضيف
    round: 0,
    votes: {}, // voterId -> targetId (مرحلة voting فقط)
    finalPlayers: null, // [id, id] لما نوصل النهائي
    finalChoices: {}, // playerId -> 'split' | 'steal'
    finalResult: null,
    finalDeck: generateDefaultFinalDeck(), // ٢٠ كارت يجهزها المضيف قبل البطولة (قيمة افتراضية جاهزة)
    finalStage: null, // null | 'select' | 'reveal' | 'choice' — فقط أثناء الجولة النهائية
    finalSequence: [], // الـ 6 كروت المختارة للنهائي بترتيب الكشف
    finalRevealIndex: 0,
    finalRunningTotal: 0,
    finalPot: null,
    createdAt: Date.now(),
    emptyTimer: null,
  };
  // ملاحظة: المضيف يراقب فقط ولا يُضاف كلاعب — دوره منفصل تماماً عن اللعب
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

function requestJoin(code, socketId, name) {
  const room = getRoom(code);
  if (!room) return { error: "الغرفة غير موجودة" };
  if (room.phase !== "lobby") return { error: "اللعبة بدأت بالفعل، لا يمكن الانضمام الآن" };
  if (room.players.size >= 12) return { error: "الغرفة ممتلئة" };
  clearEmptyTimer(room);
  room.pending.set(socketId, { id: socketId, name: (name || "لاعب").slice(0, 20) });
  return { room };
}

function approveJoin(room, targetId) {
  const req = room.pending.get(targetId);
  if (!req) return { error: "طلب الانضمام غير موجود (ربما انسحب اللاعب)" };
  room.pending.delete(targetId);
  room.players.set(targetId, makePlayer(targetId, req.name));
  return {};
}

function rejectJoin(room, targetId) {
  room.pending.delete(targetId);
}

function kickPlayer(room, targetId, requesterId) {
  if (room.hostId !== requesterId) return { error: "بس المضيف يقدر يطرد لاعب" };
  if (targetId === room.hostId) return { error: "ما تقدر تطرد نفسك" };
  const existed = room.players.delete(targetId);
  if (!existed) return { error: "لاعب غير موجود" };
  return {};
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
    if (room.hostId === socketId) {
      // المضيف انقطع أو غادر — ننقل الصلاحية لأول لاعب متصل، ولو محد موجود تبقى الغرفة بدون مضيف مؤقتاً
      const nextHost = [...room.players.values()].find((p) => p.connected);
      room.hostId = nextHost ? nextHost.id : null;
      maybeScheduleCleanup(room);
      return room;
    }
    if (room.pending.has(socketId)) {
      room.pending.delete(socketId);
      maybeScheduleCleanup(room);
      return room;
    }
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
  if (!hasConnectedPlayers && room.displays.size === 0 && room.pending.size === 0) {
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

// ---------- بدء اللعبة وتوزيع الكروت ----------

function dealCards(room) {
  const activePlayers = [...room.players.values()].filter((p) => p.connected);
  const killerCount = Math.min(
    Math.max(1, Math.floor(activePlayers.length / 4)),
    Math.max(activePlayers.length - 2, 1)
  );
  const shuffled = [...activePlayers].sort(() => Math.random() - 0.5);
  const killerIds = new Set(shuffled.slice(0, killerCount).map((p) => p.id));

  for (const player of room.players.values()) {
    if (!player.connected) continue;
    const cards = Array.from({ length: CARDS_PER_PLAYER }, () => ({
      value: randomMoneyValue(),
      isKiller: false,
    }));
    if (killerIds.has(player.id)) {
      const idx = Math.floor(Math.random() * cards.length);
      cards[idx] = { value: 0, isKiller: true };
      player.isKiller = true;
    } else {
      player.isKiller = false;
    }
    player.cards = cards;
    player.revealedCard = null;
    player.isEliminated = false;
  }

  room.round = 1;
  room.phase = "discussion";
  room.votes = {};
  room.finalPlayers = null;
  room.finalChoices = {};
  room.finalResult = null;
  revealRoundCards(room);
}

function revealRoundCards(room) {
  for (const player of room.players.values()) {
    if (player.isEliminated || !player.cards.length) continue;
    const idx = Math.min(room.round - 1, player.cards.length - 1);
    const card = player.cards[idx];
    player.revealedCard = card.isKiller ? "بطاقة القاتل ☠" : formatMoney(card.value);
  }
}

function startVoting(room, requesterId) {
  if (room.hostId !== requesterId) return { error: "بس المضيف يقدر يبدأ التصويت" };
  if (room.phase !== "discussion") return { error: "مو وقت التصويت الآن" };
  room.phase = "voting";
  room.votes = {};
  return {};
}

// ---------- التصويت والإقصاء ----------

function stillInGame(room) {
  return [...room.players.values()].filter((p) => !p.isEliminated);
}

function activeVoters(room) {
  return stillInGame(room).filter((p) => p.connected);
}

function castVote(room, voterId, targetId) {
  if (room.phase !== "voting") return { error: "مو وقت التصويت" };
  const voter = room.players.get(voterId);
  if (!voter || voter.isEliminated) return { error: "غير مسموح لك بالتصويت" };
  const target = room.players.get(targetId);
  if (!target || target.isEliminated) return { error: "لاعب غير صالح للتصويت ضده" };
  room.votes[voterId] = targetId;
  return {};
}

function allVotesIn(room) {
  const voters = activeVoters(room);
  return voters.length > 0 && voters.every((p) => room.votes[p.id]);
}

function resolveVoting(room) {
  const tally = {};
  for (const targetId of Object.values(room.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }
  let max = 0;
  let candidates = [];
  for (const [id, count] of Object.entries(tally)) {
    if (count > max) {
      max = count;
      candidates = [id];
    } else if (count === max) {
      candidates.push(id);
    }
  }
  if (candidates.length > 0) {
    const eliminatedId = candidates[Math.floor(Math.random() * candidates.length)];
    const eliminated = room.players.get(eliminatedId);
    if (eliminated) eliminated.isEliminated = true;
  }

  room.votes = {};
  const remaining = stillInGame(room);

  if (remaining.length <= 2) {
    room.phase = "final";
    room.finalPlayers = remaining.map((p) => p.id);
    room.finalChoices = {};
    room.finalStage = "select";
    room.finalSequence = [];
    room.finalRevealIndex = 0;
    room.finalRunningTotal = 0;
    room.finalPot = null;
  } else {
    room.round += 1;
    room.phase = "discussion";
    revealRoundCards(room);
  }
}

// ---------- إعداد كروت الجولة النهائية (يجهزها المضيف) ----------

function setFinalDeck(room, requesterId, cards) {
  if (room.hostId !== requesterId) return { error: "بس المضيف يقدر يعدّل كروت النهائي" };
  if (room.phase === "final" || room.phase === "ended")
    return { error: "ما تقدر تعدّل الكروت بعد بداية الجولة النهائية" };
  if (!Array.isArray(cards) || cards.length !== FINAL_DECK_SIZE)
    return { error: `لازم بالضبط ${FINAL_DECK_SIZE} كارت` };

  const cleaned = cards.map((c, i) => ({
    id: `c${i + 1}`,
    value: Math.max(0, Number(c.value) || 0),
    isKiller: !!c.isKiller,
    label: c.isKiller ? (c.label ? String(c.label).slice(0, 20) : "القاتل") : null,
  }));
  room.finalDeck = cleaned;
  return {};
}

// ---------- اختيار وكشف كروت الجولة النهائية ----------

function selectFinalCards(room, requesterId, cardIds) {
  if (room.phase !== "final" || room.finalStage !== "select")
    return { error: "مو وقت اختيار كروت النهائي" };
  if (room.hostId !== requesterId) return { error: "بس المضيف يقدر يختار كروت النهائي" };
  if (!Array.isArray(cardIds) || cardIds.length !== FINAL_CARDS_TO_REVEAL)
    return { error: `لازم تختار بالضبط ${FINAL_CARDS_TO_REVEAL} كروت` };

  const unique = new Set(cardIds);
  if (unique.size !== cardIds.length) return { error: "ما تقدر تختار نفس الكارت مرتين" };

  const sequence = [];
  for (const id of cardIds) {
    const card = room.finalDeck.find((c) => c.id === id);
    if (!card) return { error: "كارت غير موجود بالمجموعة" };
    sequence.push(card);
  }

  room.finalSequence = sequence;
  room.finalRevealIndex = 0;
  room.finalRunningTotal = 0;
  room.finalStage = "reveal";
  return {};
}

function revealNextFinalCard(room, requesterId) {
  if (room.phase !== "final" || room.finalStage !== "reveal")
    return { error: "مو وقت كشف كروت النهائي" };
  if (room.hostId !== requesterId) return { error: "بس المضيف يقدر يكشف الكروت" };
  if (room.finalRevealIndex >= room.finalSequence.length) return { error: "خلصت الكروت" };

  const card = room.finalSequence[room.finalRevealIndex];
  room.finalRunningTotal = card.isKiller ? 0 : room.finalRunningTotal + card.value;
  room.finalRevealIndex += 1;

  if (room.finalRevealIndex >= room.finalSequence.length) {
    room.finalStage = "choice";
    room.finalPot = room.finalRunningTotal;
  }
  return {};
}

// ---------- الجولة النهائية: شاركني / اسرقني ----------

function castFinalChoice(room, playerId, choice) {
  if (room.phase !== "final") return { error: "مو وقت القرار النهائي" };
  if (room.finalStage !== "choice") return { error: "بننتظر كشف كل كروت الجولة النهائية الأول" };
  if (!room.finalPlayers?.includes(playerId)) return { error: "أنت مو من ضمن النهائي" };
  if (!["split", "steal"].includes(choice)) return { error: "اختيار غير صالح" };
  room.finalChoices[playerId] = choice;
  return {};
}

function finalChoicesReady(room) {
  return room.finalPlayers.every((id) => room.finalChoices[id]);
}

function resolveFinal(room) {
  const [aId, bId] = room.finalPlayers;
  const a = room.players.get(aId);
  const b = room.players.get(bId);
  const pot = room.finalPot ?? 0;
  const choiceA = room.finalChoices[aId];
  const choiceB = room.finalChoices[bId];

  let payout;
  let outcome;
  if (choiceA === "split" && choiceB === "split") {
    payout = { [aId]: pot / 2, [bId]: pot / 2 };
    outcome = "split_split";
  } else if (choiceA === "steal" && choiceB === "steal") {
    payout = { [aId]: 0, [bId]: 0 };
    outcome = "steal_steal";
  } else if (choiceA === "steal") {
    payout = { [aId]: pot, [bId]: 0 };
    outcome = "a_stole";
  } else {
    payout = { [aId]: 0, [bId]: pot };
    outcome = "b_stole";
  }

  room.phase = "ended";
  room.finalResult = {
    pot,
    outcome,
    players: { [aId]: { name: a.name }, [bId]: { name: b.name } },
    choices: { [aId]: choiceA, [bId]: choiceB },
    payout,
  };
}



// الحالة العامة المسموح للجميع رؤيتها (لاعبين + شاشة العرض)
function getPublicState(room) {
  const voteCounts = {};
  if (room.phase === "voting") {
    for (const targetId of Object.values(room.votes)) {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
  }
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    hostName: room.hostName,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isEliminated: p.isEliminated,
      revealedCard: p.revealedCard, // فقط الكارت المكشوف، أبداً باقي الكروت أو isKiller
      voteCount: voteCounts[p.id] || 0,
    })),
    finalPlayers: room.finalPlayers,
    finalSubmitted: Object.keys(room.finalChoices || {}),
    finalResult: room.phase === "ended" ? room.finalResult : null,
    finalStage: room.finalStage,
    finalSequence:
      room.finalStage && room.finalStage !== "select"
        ? room.finalSequence.map((c, i) =>
            i < room.finalRevealIndex
              ? { value: c.value, isKiller: c.isKiller, label: c.label, revealed: true }
              : { revealed: false }
          )
        : null,
    finalRunningTotal: room.finalRunningTotal,
    finalPot: room.finalStage === "choice" || room.phase === "ended" ? room.finalPot : null,
  };
}

// الحالة الخاصة للاعب معين — تضيف كروته السرية فقط له
function getPrivateStateFor(room, socketId) {
  const me = room.players.get(socketId);
  const isHost = socketId === room.hostId;
  return {
    ...getPublicState(room),
    you: me
      ? {
          id: me.id,
          name: me.name,
          cards: me.cards,
          isKiller: me.isKiller,
          hasVoted: !!room.votes[socketId],
          myVoteTarget: room.votes[socketId] || null,
        }
      : null,
    pendingRequests: isHost ? [...room.pending.values()] : [],
    finalDeck: isHost ? room.finalDeck : null,
  };
}

export {
  rooms,
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
  setFinalDeck,
  selectFinalCards,
  revealNextFinalCard,
  castFinalChoice,
  finalChoicesReady,
  resolveFinal,
};

