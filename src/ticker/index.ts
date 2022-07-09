import "dotenv/config";
import { DateTime } from "luxon";
import { ticker, tryTick } from "./ticker";

console.log("Starting...");

(async () => {
  const schedule = (task: () => void) =>
    setTimeout(task, ticker.sleepUntil.minus(DateTime.now()).toMillis());
  const tickTask = async () => {
    if (DateTime.now().toMillis() > ticker.sleepUntil.toMillis()) {
      // eslint-disable-next-line no-await-in-loop
      await tryTick();
    }
    schedule(tickTask);
  };
  schedule(tickTask);
})();
