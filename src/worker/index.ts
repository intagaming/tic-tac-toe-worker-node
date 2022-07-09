import "dotenv/config";
import amqplib from "amqplib";
import handle from "./worker";

console.log("Starting...");

const ablyQueueName = process.env.ABLY_QUEUE_NAME ?? "";
const amqpUrl = process.env.AMQP_URL ?? "";

(async () => {
  const conn = await amqplib.connect(amqpUrl);
  console.log("Connected to Ably Queue");

  const ch1 = await conn.createChannel();
  console.log("Opened a channel on the Ably queue connection");

  console.log("Listening for messages on queue");
  ch1.consume(ablyQueueName, (msg) => {
    if (msg !== null) {
      handle(msg);
      ch1.ack(msg);
    } else {
      console.log("Consumer cancelled by server");
    }
  });
})();
