import { RpcTarget, newWebSocketRpcSession } from "capnweb";

type WasmBindings = {
  ui_append_log_line?: (line: string) => void;
  ui_set_status_text?: (text: string) => void;
  ui_set_log_lines?: (lines: string[]) => void;
  ui_set_audio_files?: (files: string[]) => void;
  ui_set_command_text?: (text: string) => void;
  ui_set_play_text?: (text: string) => void;
  ui_set_broadcast_text?: (text: string) => void;
  ui_set_upload_name_text?: (text: string) => void;
};

type HubApi = {
  addClient(stub: ClientStub, descriptor: ClientDescriptor): Promise<number>;
  broadcast(message: unknown): Promise<number>;
  runCommand(command: string, clientId?: string): Promise<unknown>;
};

type ClientDescriptor = {
  id: string;
  joinedAt: string;
  vector: number[];
};

type ClientStub = RpcTarget;

type BroadcastPayload = {
  type?: string;
  message?: unknown;
  audioFiles?: string[];
  logLines?: string[];
  status?: string;
  filename?: string;
  [key: string]: unknown;
};

let wasmBindings: WasmBindings | null = null;
let api: HubApi | null = null;
let descriptor: ClientDescriptor | null = null;
let connected = false;

const LOG_PREFIX = "[client]";

export function attachWasmBindings(bindings: WasmBindings) {
  wasmBindings = bindings;
}

function logLine(line: string) {
  console.log(line);
  wasmBindings?.ui_append_log_line?.(line);
}

function setStatus(text: string) {
  wasmBindings?.ui_set_status_text?.(text);
}

function determineHost(): string {
  const params = new URLSearchParams(window.location.search);
  if (params.has("ws")) {
    return params.get("ws")!;
  }
  if (params.has("host")) {
    return params.get("host")!;
  }
  const { protocol, host } = window.location;
  const wsProto = protocol === "https:" ? "wss" : "ws";
  return `${wsProto}://${host}/ws`;
}

function toHttpUrl(path: string): string {
  try {
    const url = new URL(state.host);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch (error) {
    const httpProto = window.location.protocol === "https:" ? "https" : "http";
    const base = state.host.replace(/^wss?/, httpProto);
    return `${base}${path}`;
  }
}

function playAudio(url: string) {
  const audio = new Audio(url);
  audio.play().catch((error) => {
    logLine(`${LOG_PREFIX} audio playback failed: ${String(error)}`);
  });
}

class HubClient extends RpcTarget {
  override broadcast(message: unknown): void {
    logLine(`${LOG_PREFIX} incoming broadcast: ${JSON.stringify(message)}`);
    if (!wasmBindings) {
      return;
    }

    const payload = message as BroadcastPayload;

    if (Array.isArray(payload?.logLines)) {
      wasmBindings.ui_set_log_lines?.(payload.logLines);
    }

    if (Array.isArray(payload?.audioFiles)) {
      wasmBindings.ui_set_audio_files?.(payload.audioFiles);
    }

    if (typeof payload?.status === "string") {
      setStatus(payload.status);
    }

    if (payload?.type === "play-audio" && typeof payload.filename === "string") {
      const filename = payload.filename as string;
      logLine(`${LOG_PREFIX} playing audio: ${filename}`);
      const url = toHttpUrl(`/audio/${encodeURIComponent(filename)}`);
      playAudio(url);
    }
  }
}

const state = {
  host: determineHost(),
  client: new HubClient(),
};

async function ensureConnection(): Promise<void> {
  if (connected) {
    return;
  }
  try {
    setStatus("Status: connecting...");
    logLine(`${LOG_PREFIX} connecting to ${state.host}`);
    const session = newWebSocketRpcSession<HubApi>(state.host);
    const newDescriptor: ClientDescriptor = {
      id: crypto.randomUUID(),
      joinedAt: new Date().toISOString(),
      vector: Array.from({ length: 3 }, () => parseFloat(Math.random().toFixed(3))),
    };
    descriptor = newDescriptor;
    const total = await session.addClient(state.client, newDescriptor);
    api = session;
    connected = true;
    setStatus("Status: connected");
    logLine(`${LOG_PREFIX} connected (${total} clients)`);
  } catch (error) {
    logLine(`${LOG_PREFIX} connection failed: ${String(error)}`);
    setStatus("Status: disconnected");
    connected = false;
    api = null;
  }
}

async function callRunCommand(command: string, clientId?: string): Promise<void> {
  if (!api) {
    await ensureConnection();
  }
  if (!api) {
    logLine(`${LOG_PREFIX} cannot send command; not connected`);
    return;
  }
  try {
    const response = await api.runCommand(command, clientId);
    logLine(`${LOG_PREFIX} command response: ${JSON.stringify(response)}`);
  } catch (error) {
    logLine(`${LOG_PREFIX} command error: ${String(error)}`);
  }
}

async function callBroadcast(message: unknown): Promise<void> {
  if (!api) {
    await ensureConnection();
  }
  if (!api) {
    logLine(`${LOG_PREFIX} cannot broadcast; not connected`);
    return;
  }
  try {
    await api.broadcast(message);
  } catch (error) {
    logLine(`${LOG_PREFIX} broadcast error: ${String(error)}`);
  }
}

export const clientApi = {
  init(): void {
    ensureConnection().catch((error) => {
      logLine(`${LOG_PREFIX} init error: ${String(error)}`);
    });
  },
  refreshStatus(): void {
    callRunCommand("status");
  },
  fetchFiles(): void {
    callRunCommand("files");
  },
  showPeers(): void {
    callRunCommand("peers");
  },
  sendCommand(command: string): void {
    callRunCommand(command);
  },
  playAudio(filename: string): void {
    if (!filename) {
      return;
    }
    const url = toHttpUrl(`/audio/${encodeURIComponent(filename)}`);
    logLine(`${LOG_PREFIX} playing audio ${url}`);
    playAudio(url);
    callRunCommand(`play ${filename}`);
  },
  broadcastMessage(message: string): void {
    callBroadcast({ type: "broadcast-message", message });
  },
  broadcastPlay(filename: string): void {
    callBroadcast({ type: "play-audio", filename, from: descriptor?.id ?? null });
  },
  chooseFile(): void {
    logLine(`${LOG_PREFIX} choose file not supported in web client`);
  },
  uploadFile(name: string): void {
    logLine(`${LOG_PREFIX} upload ${name} not supported in web client`);
  },
  audioFileClicked(name: string): void {
    clientApi.playAudio(name);
  },
};

export type { WasmBindings };
