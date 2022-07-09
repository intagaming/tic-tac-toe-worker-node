export interface QueueMessage {
  source: string;
  appId: string;
  channel: string;
  site: string;
  ruleId: string;
}

type Presence = {
  id: string;
  clientId: string;
  connectionId: string;
  timestamp: number;
  name: string;
  action: number;
  data: string;
};

export interface PresenceMessage extends QueueMessage {
  presence: Presence[];
}

type Message = {
  id: string;
  clientId: string;
  connectionId: string;
  timestamp: number;
  name: string;
  data: string;
};

export interface MessageMessage extends QueueMessage {
  messages: Message[];
}

type TicTacToeData = {
  ticks: number;
  board: (string | null)[];
  turn: string;
  turnEndsAt: number;
  // gameEndsAt is in Unix seconds.
  gameEndsAt: number;
};

export type Room = {
  id: string;
  host: string | null;
  state: string;
  guest: string | null;
  data: TicTacToeData;
};
