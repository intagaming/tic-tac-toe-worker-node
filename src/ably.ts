import * as Ably from "ably";

const ablyApiKey = process.env.ABLY_API_KEY ?? "";
const ably = new Ably.Realtime(ablyApiKey ?? "");

export default ably;
