/* eslint-disable no-await-in-loop */
import { DateTime, Duration } from "luxon";
import Redlock from "redlock";
import redis from "../shared/redis";
import { getRoom, saveRoomToRedis } from "../shared/utils";
import ably from "../shared/ably";
import { Announcers } from "../worker/worker";

type Ticker = {
  idle: boolean;
  idleHalfTicks: number;
  sleepUntil: DateTime;
};

export const Options = {
  tickTime: Duration.fromDurationLike({ seconds: 2 }),
  idleHalfTicksTrigger: 10, // After this amount of half-tick idling, idle mode will be on.
  idleInterval: Duration.fromDurationLike({ seconds: 5 }), // In idle mode, we will tick every following interval.
  // pushbackTime is the time that the ticker will add into the score of the room while it is processing the room in order
  // to prevent the room from being realized by other tickers. This results in the rooms that need ticking the most having
  // the lowest scores and being realized before the being-processed task.
  pushbackTime: Duration.fromDurationLike({
    seconds: 6,
  }),
};

export const ticker: Ticker = {
  idle: false,
  idleHalfTicks: 0,
  sleepUntil: DateTime.now(),
};

export const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 0,
  retryDelay: 200,
  retryJitter: 200,
  automaticExtensionThreshold: 500,
});

const idleHalfTick = () => {
  if (!ticker.idle && ticker.idleHalfTicks > Options.idleHalfTicksTrigger) {
    console.log("Idle mode enabled.");
    ticker.idle = true;
    ticker.idleHalfTicks = 0;
    ticker.sleepUntil = DateTime.now().plus(Options.idleInterval);
    return;
  }
  if (ticker.idle) {
    ticker.sleepUntil = DateTime.now().plus(Options.idleInterval);
  } else {
    ticker.idleHalfTicks += 1;
    ticker.sleepUntil = DateTime.now().plus(
      Duration.fromDurationLike({ seconds: Options.tickTime.seconds / 2 })
    );
  }
};

const idleOff = () => {
  ticker.idle = false;
  ticker.idleHalfTicks = 0;
  console.log("Idle mode disabled. Ticking mode enabled.");
};

const idleOffWithSleepUntil = (sleepUntil: DateTime) => {
  idleOff();
  ticker.sleepUntil = sleepUntil;
};

// Returns whether the room will be in need of more ticking in the future.
const tick = async (roomId: string): Promise<boolean> => {
  const room = await getRoom(roomId);
  if (room === null) {
    console.log(`Room ${roomId} not found.`);
    return false;
  }
  const serverChannel = ably.channels.get(`server:${roomId}`);

  // Check if the room is past gameEndsAt
  if (room.data.gameEndsAt !== -1) {
    const gameEndsAt = DateTime.fromSeconds(room.data.gameEndsAt);
    if (DateTime.now() > gameEndsAt) {
      // Ends the game
      // Reset the room state to waiting
      room.state = "waiting";
      room.data.ticks = 0;
      room.data.board = [null, null, null, null, null, null, null, null, null];
      room.data.turn = "host";
      room.data.turnEndsAt = -1;
      room.data.gameEndsAt = -1;
      saveRoomToRedis(room);

      // Announce the game ended
      serverChannel.publish(Announcers.GameFinished, "");
      return false;
    }
    return true;
  }

  // TODO: Turn timer

  return true;
};

// eslint-disable-next-line import/prefer-default-export
export const tryTick = async () => {
  // Keep trying until ticking once, then quit tick()
  for (;;) {
    // Find the lowest score task in the queue
    const result = await redis.zrange("tickingRooms", 0, 0, "WITHSCORES");
    if (result.length === 0) {
      // Sleep half a tick because we're not very busy
      idleHalfTick();
      return;
    }
    const [roomId, score] = result;
    const startTime = DateTime.now();
    const unix = DateTime.fromMillis(parseInt(score, 10));
    if (DateTime.now() < unix) {
      // Sleep min(half a tick, time until the task is due)
      if (unix.diffNow().seconds < Options.tickTime.seconds / 2) {
        // If the task is due soon
        if (ticker.idle) {
          idleOffWithSleepUntil(unix);
        } else {
          ticker.sleepUntil = unix;
        }
      } else {
        idleHalfTick();
      }
      return;
    }

    // We're in business. If in idle mode, turn it off.
    if (ticker.idle) {
      idleOff();
    }
    if (ticker.idleHalfTicks > 0) {
      ticker.idleHalfTicks = 0;
    }

    // Try to acquire lock on the room
    const mutexName = `tick:${roomId}`;
    const lock = await redlock.acquire([mutexName], 5000);

    let willTickMore: boolean | undefined; // TODO: is this default sensible?
    let nextTickTime: DateTime | undefined;
    try {
      // After acquiring the lock, check if the task has been processed by another ticker. Happens if the task's time
      // is checked at the same time to be processable by 2 tickers, then both ticker attempts to acquire the lock.
      // The first ticker processes the task, then the second one get the chance, but the task is already processed.
      // Also, if the task is deleted by the worker, the following command will error, and we would skip.
      const scoreCheck = await redis.zscore("tickingRooms", roomId);
      if (scoreCheck !== score) {
        console.log(
          `Room ${roomId} has already been processed by another ticker.`
        );
        // eslint-disable-next-line no-continue
        continue;
      }

      // Push back the task in order to prevent other tickers from realizing it first.
      await redis.zadd(
        "tickingRooms",
        DateTime.now().plus(Options.pushbackTime).toMillis(),
        roomId
      );

      // Getting room
      // Tick
      willTickMore = await tick(roomId);

      if (!willTickMore) {
        // Remove the room from the tickingRooms list
        await redis.zrem("tickingRooms", roomId);
      } else {
        // Schedule next tick
        nextTickTime = unix.plus(Options.tickTime);
        await redis.zadd("tickingRooms", nextTickTime.toMillis(), roomId);
      }
    } finally {
      await lock.release();
    }

    const timeElapsed = DateTime.now().diff(startTime);
    if (willTickMore && nextTickTime && DateTime.now() > nextTickTime) {
      console.log(`Room ${roomId} is late. Don't delay! Tick today.`);
      return;
    }
    if (timeElapsed.seconds < Options.tickTime.seconds / 2) {
      // We only do one ticking every half a tick, so we need to sleep for the remaining time
      ticker.sleepUntil = DateTime.now().plus(
        Duration.fromDurationLike({
          seconds: Options.tickTime.seconds / 2 - timeElapsed.seconds,
        })
      );
    }
    return;
  }
};
