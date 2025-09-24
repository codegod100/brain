import { randomUUID } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";

type ClientDescriptor = {
  id: string;
  joinedAt: string;
  vector: number[];
};

class Client extends RpcTarget {
  broadcast(message: unknown) {
    if (typeof message === "string") {
      console.log(`Incoming message! ${message}`);
    } else {
      try {
        console.log("Incoming message!\n" + JSON.stringify(message, null, 2));
      } catch (error) {
        console.log("Incoming message!", message);
      }
    }
  }
}

type HubApi = {
  addClient(stub: Client, descriptor: ClientDescriptor): Promise<number>;
  broadcast(message: unknown): Promise<number>;
  runCommand(command: string): Promise<unknown>;
};

const api = newWebSocketRpcSession<HubApi>("ws://localhost:8787");
const descriptor: ClientDescriptor = {
  id: randomUUID(),
  joinedAt: new Date().toISOString(),
  vector: Array.from({ length: 3 }, () => Number.parseFloat(Math.random().toFixed(3))),
};

const client = new Client();
const total = await api.addClient(client, descriptor);
console.log(`Connected clients: ${total}`);
console.log('Commands available: type "files" or "help"; "exit" to quit.');

const rl = createInterface({ input: stdin, output: stdout });

try {
  for await (const line of rl) {
    const command = line.trim();
    if (!command) {
      continue;
    }
    if (command === "exit" || command === "quit") {
      break;
    }

    try {
      const response = await api.runCommand(command);
      console.log("Command response:\n" + JSON.stringify(response, null, 2));
    } catch (error) {
      console.error("Command failed", error);
    }
  }
} finally {
  rl.close();
}
