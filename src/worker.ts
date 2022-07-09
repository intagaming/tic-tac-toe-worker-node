import amqplib from "amqplib";
import { DateTime } from "luxon";
import ably from "./ably";
import redis from "./redis";
import { MessageMessage, PresenceMessage, Room } from "./types";
import { getRoom, roomIdFromControlChannel, saveRoomToRedis } from "./utils";

const roomTimeoutSeconds = 60;

enum Announcers {
  HostChange = "HOST_CHANCE",
  RoomState = "ROOM_STATE",
  GameStartsNow = "GAME_STARTS_NOW",
  ClientLeft = "CLIENT_LEFT",
  PlayerCheckedBox = "PLAYER_CHECKED_BOX",
  GameResultAnnounce = "GAME_RESULT",
  GameFinishing = "GAME_FINISHING",
  GameFinished = "GAME_FINISHED",
}

enum Actions {
  StartGame = "START_GAME",
  LeaveRoom = "LEAVE_ROOM",
  CheckBox = "CHECK_BOX",
}

const onControlChannelEnter = async (presenceMsg: PresenceMessage) => {
  const presence = presenceMsg.presence[0];
  const { channel } = presenceMsg;
  const roomId = roomIdFromControlChannel(channel);
  const { clientId } = presence;
  const serverChannel = ably.channels.get(`server:${roomId}`);
  const room = await getRoom(roomId);
  if (room === null) {
    console.log("Failed to get room");
    return;
  }

  if (room.host === null) {
    // Set as host
    // TODO: fix race condition when we're setting the host but someone else joins first and became the host?
    room.host = clientId;
    // Save, and persist the room
    await saveRoomToRedis(room, 0);
    // Persist the client's roomId
    await redis.set(`client:${clientId}`, roomId, "EX", 0);

    // Send the room state
    serverChannel.publish(Announcers.RoomState, JSON.stringify(room));
  } else if (room.host !== clientId && room.guest === null) {
    // Set as guest
    room.guest = clientId;
    // Save, and persist the room
    await saveRoomToRedis(room, 0);
    // Persist the client's roomId
    await redis.set(`client:${clientId}`, roomId, "EX", 0);

    // Send the room state
    serverChannel.publish(Announcers.RoomState, JSON.stringify(room));
  } else if (room.host === clientId || room.guest === clientId) {
    // If re-joining
    // Persist the client's roomId
    redis.set(`client:${clientId}`, roomId, "EX", 0);
    // Persist the room
    redis.persist(`room:${roomId}`);
  }

  // Send the room state
  serverChannel.publish(Announcers.RoomState, JSON.stringify(room));
};

const onEnter = (presenceMsg: PresenceMessage) => {
  const presence = presenceMsg.presence[0];
  console.log(`${presence.name} entered channel ${presenceMsg.channel}`);

  const { channel } = presenceMsg;
  if (channel.startsWith("control:")) {
    onControlChannelEnter(presenceMsg);
  }
};

const expireRoomIfNecessary = async (room: Room, leftClientId: string) => {
  // Set expiration for the room if all clients have left
  let toCheck: string | null;
  if (room.host !== null && room.host === leftClientId) {
    toCheck = room.guest;
  } else if (room.guest !== null && room.guest === leftClientId) {
    toCheck = room.host;
  } else {
    return;
  }
  if (toCheck === null) {
    // If there's no one left, expire the room
    redis.expire(`room:${room.id}`, roomTimeoutSeconds);
  } else {
    const ttl = await redis.ttl(`client:${toCheck}`);
    const clientRoomId = await redis.get(`client:${toCheck}`);
    // Even when we didn't find the client, we still expire the room anyway, because the client is nowhere to be found.

    // If the other client disappeared, or is not in the room, or the room they're in is not the room in question, then expire the room.
    if (ttl !== -1 || clientRoomId !== room.id) {
      redis.expire(`room:${room.id}`, roomTimeoutSeconds);
    }
  }
};

const onControlChannelLeave = async (presenceMsg: PresenceMessage) => {
  const presence = presenceMsg.presence[0];
  const { channel } = presenceMsg;
  const roomId = roomIdFromControlChannel(channel);
  const { clientId } = presence;
  const room = await getRoom(roomId);
  if (room === null) {
    console.log("Failed to get room");
    return;
  }

  // The client has some time to join the room again. The due time is before the
  // time the room expires minus 10 seconds. The 10 seconds is the wiggle-room,
  // because if the player joins right at the time that the room is about to
  // expire, the room might have already expired by the time the player
  // establishes connection.
  redis.expire(`client:${clientId}`, roomTimeoutSeconds - 10);
  expireRoomIfNecessary(room, clientId);
};

const onLeave = (presenceMsg: PresenceMessage) => {
  const presence = presenceMsg.presence[0];
  console.log(`${presence.name} left channel ${presenceMsg.channel}`);

  const { channel } = presenceMsg;
  if (channel.startsWith("control:")) {
    onControlChannelLeave(presenceMsg);
  }
};

const presenceActions = {
  absent: 0,
  present: 1,
  enter: 2,
  leave: 3,
  update: 4,
};

const handlePresence = (presenceMsg: PresenceMessage) => {
  const presence = presenceMsg.presence[0];
  switch (presence.action) {
    case presenceActions.enter:
      onEnter(presenceMsg);
      break;
    case presenceActions.leave:
      onLeave(presenceMsg);
      break;
    default:
      break;
  }
};

enum GameResult {
  Undecided,
  HostWin,
  GuestWin,
  Draw,
}

const gameResultBasedOnString = (hostOrGuest: string): GameResult => {
  if (hostOrGuest === "host") {
    return GameResult.HostWin;
  }
  if (hostOrGuest === "guest") {
    return GameResult.GuestWin;
  }
  return GameResult.Undecided;
};

const gameResult = (room: Room) => {
  const { board } = room.data;

  if (board[0] !== null && board[0] === board[1] && board[1] === board[2]) {
    return gameResultBasedOnString(board[0]);
  }
  if (board[3] !== null && board[3] === board[4] && board[4] === board[5]) {
    return gameResultBasedOnString(board[3]);
  }
  if (board[6] !== null && board[6] === board[7] && board[7] === board[8]) {
    return gameResultBasedOnString(board[6]);
  }
  if (board[0] !== null && board[0] === board[3] && board[3] === board[6]) {
    return gameResultBasedOnString(board[0]);
  }
  if (board[1] !== null && board[1] === board[4] && board[4] === board[7]) {
    return gameResultBasedOnString(board[1]);
  }
  if (board[2] !== null && board[2] === board[5] && board[5] === board[8]) {
    return gameResultBasedOnString(board[2]);
  }
  if (board[0] !== null && board[0] === board[4] && board[4] === board[8]) {
    return gameResultBasedOnString(board[0]);
  }
  if (board[2] !== null && board[2] === board[4] && board[4] === board[6]) {
    return gameResultBasedOnString(board[2]);
  }

  // Check if draw
  if (
    board[0] !== null &&
    board[1] !== null &&
    board[2] !== null &&
    board[3] !== null &&
    board[4] !== null &&
    board[5] !== null &&
    board[6] !== null &&
    board[7] !== null &&
    board[8] !== null
  ) {
    return GameResult.Draw;
  }

  return GameResult.Undecided;
};

const onControlChannelMessage = async (messageMsg: MessageMessage) => {
  const msg = messageMsg.messages[0];
  const { channel } = messageMsg;
  const roomId = roomIdFromControlChannel(channel);
  const { clientId } = msg;
  const serverChannel = ably.channels.get(`server:${roomId}`);
  const room = await getRoom(roomId);
  if (room === null) {
    console.log("Failed to get room");
    return;
  }

  switch (msg.name) {
    case Actions.StartGame: {
      if (
        room.state !== "waiting" ||
        room.host === null ||
        room.guest === null ||
        room.host !== msg.clientId
      ) {
        return;
      }

      // Starting the game...
      const now = DateTime.now();
      const turnEndsAt = now.plus({ seconds: 30 }).toUnixInteger();
      room.state = "playing";
      room.data.turnEndsAt = turnEndsAt;
      saveRoomToRedis(room);

      // Add the game to the ticker sorted set
      redis.zadd("tickingRooms", now.toMillis(), room.id);

      serverChannel.publish(Announcers.GameStartsNow, JSON.stringify(room));
      break;
    }
    case Actions.LeaveRoom: {
      // Remove player from room
      const clientToRemove = msg.data;
      if (room.host === clientToRemove) {
        // If we have a guest, make that guest the new host
        if (room.guest !== null) {
          serverChannel.publish(Announcers.HostChange, room.guest);

          room.host = room.guest;
          room.guest = null;
        } else {
          room.host = null;
        }
      } else if (room.guest === clientToRemove) {
        room.guest = null;
      }
      saveRoomToRedis(room);
      serverChannel.publish(Announcers.ClientLeft, clientToRemove);

      // End the game if playing
      if (room.state === "playing") {
        room.state = "finishing";
        const gameEndsAt = DateTime.now().plus({ seconds: 5 }).toUnixInteger();
        room.data.gameEndsAt = gameEndsAt;
        saveRoomToRedis(room);
        serverChannel.publish(Announcers.GameFinishing, gameEndsAt.toString());
      }

      expireRoomIfNecessary(room, clientToRemove);
      break;
    }
    case Actions.CheckBox: {
      const boxToCheck = parseInt(msg.data, 10);

      // Check if is host or guest
      let isHost: boolean;
      if (clientId !== room.host && clientId !== room.guest) {
        return;
      }
      if (room.host === clientId) {
        isHost = true;
      } else if (room.guest === clientId) {
        isHost = false;
      } else {
        return;
      }

      // Check if it's the client's turn
      if (
        room.host === null ||
        room.guest === null ||
        (clientId === room.host && room.data.turn !== "host") ||
        (clientId === room.guest && room.data.turn !== "guest")
      ) {
        return;
      }

      // Check if the box is already checked
      const box = room.data.board[boxToCheck];
      if (box !== null) {
        return;
      }

      const checkInto = isHost ? "host" : "guest";
      // Update the board
      room.data.board[boxToCheck] = checkInto;
      saveRoomToRedis(room);

      serverChannel.publish(
        Announcers.PlayerCheckedBox,
        JSON.stringify({
          hostOrGuest: checkInto,
          box: boxToCheck,
        })
      );

      // Check if someone's winning
      const result = gameResult(room);
      if (result !== GameResult.Undecided) {
        // Change game state
        room.state = "finishing";
        const gameEndsAt = DateTime.now().plus({ seconds: 5 }).toUnixInteger();
        room.data.gameEndsAt = gameEndsAt;
        saveRoomToRedis(room);

        // Announce game result
        let winnerClientId: string | null = null;
        if (result === GameResult.HostWin) {
          winnerClientId = room.host;
        } else if (result === GameResult.GuestWin) {
          winnerClientId = room.guest;
        }
        serverChannel.publish(Announcers.GameFinishing, gameEndsAt.toString());
        serverChannel.publish(
          Announcers.GameResultAnnounce,
          JSON.stringify({
            winner: winnerClientId,
            gameEndsAt,
          })
        );
        return;
      }

      room.data.turn = isHost ? "guest" : "host";
      saveRoomToRedis(room);
      break;
    }
    default:
      break;
  }
};

const onMessage = (messageMsg: MessageMessage) => {
  const msg = messageMsg.messages[0];
  console.log(
    `${msg.clientId} sent message ${msg} on channel ${messageMsg.channel}`
  );

  const { channel } = messageMsg;
  if (channel.startsWith("control:")) {
    onControlChannelMessage(messageMsg);
  }
};

const handleMessage = (messageMsg: MessageMessage) => {
  onMessage(messageMsg);
};

const handle = (payload: amqplib.ConsumeMessage) => {
  const payloadString = payload.content.toString();
  if (payloadString.includes("channel.presence")) {
    const msg = JSON.parse(payloadString) as PresenceMessage;
    handlePresence(msg);
  } else if (payloadString.includes("channel.message")) {
    const msg = JSON.parse(payloadString) as MessageMessage;
    handleMessage(msg);
  } else {
    console.log("Unknown message: ", payloadString);
  }
};

export default handle;
