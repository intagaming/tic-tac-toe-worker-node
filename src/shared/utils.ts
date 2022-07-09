import redis from "./redis";
import { Room } from "./types";

export const getRoom = async (roomId: string): Promise<Room | null> => {
  const json = await redis.get(`room:${roomId}`);
  if (json === null) {
    return null;
  }

  return JSON.parse(json) as Room;
};

export const roomIdFromControlChannel = (channel: string): string =>
  channel.replace("control:", "");

export const saveRoomToRedis = (room: Room, expiration?: number) => {
  if (expiration === undefined) {
    return redis.set(`room:${room.id}`, JSON.stringify(room), "KEEPTTL");
  }
  if (expiration === 0) {
    return redis.set(`room:${room.id}`, JSON.stringify(room));
  }
  return redis.set(`room:${room.id}`, JSON.stringify(room), "EX", expiration);
};
