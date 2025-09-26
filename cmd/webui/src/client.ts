import { RpcTarget, newWebSocketRpcSession } from "capnweb";

export type AudioItem = {
  name: string;
  size?: number;
  uploaded?: string;
  source?: string;
};

export type UiBindings = {
  ui_append_log_line?: (line: string) => void;
  ui_set_status_text?: (text: string) => void;
  ui_set_log_lines?: (lines: string[]) => void;
  ui_set_audio_files?: (files: AudioItem[]) => void;
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

let ui: UiBindings | null = null;
let api: HubApi | null = null;
let descriptor: ClientDescriptor | null = null;
let connected = false;

const LOG_PREFIX = "[webui]";

export function attachUiBindings(bindings: UiBindings) {
  ui = bindings;
}

function logLine(line: string) {
  console.log(line);
  ui?.ui_append_log_line?.(line);
}

function setStatus(text: string) {
  ui?.ui_set_status_text?.(text);
}

function determineHost(): string {
  const params = new URLSearchParams(window.location.search);
  if (params.has("ws")) return params.get("ws")!;
  if (params.has("host")) return params.get("host")!;
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
  void audio.play().catch((error) => {
    logLine(`${LOG_PREFIX} audio playback failed: ${String(error)}`);
  });
}

class HubClient extends RpcTarget {
  override broadcast(message: unknown): void {
    logLine(`${LOG_PREFIX} incoming broadcast: ${safeJson(message)}`);

    const payload = message as BroadcastPayload;

    if (Array.isArray(payload?.logLines)) {
      ui?.ui_set_log_lines?.(payload.logLines);
    }
    if (Array.isArray(payload?.audioFiles)) {
      ui?.ui_set_audio_files?.(normalizeAudioList(payload.audioFiles));
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

export function setHost(url: string) {
  state.host = url;
}

async function ensureConnection(): Promise<boolean> {
  if (connected) return true;
  try {
    setStatus("Status: connecting...");
    logLine(`${LOG_PREFIX} connecting to ${state.host}`);
    const session = newWebSocketRpcSession<HubApi>(state.host);
    const newDescriptor: ClientDescriptor = {
      id: crypto.randomUUID(),
      joinedAt: new Date().toISOString(),
      vector: Array.from({ length: 3 }, () => Number.parseFloat(Math.random().toFixed(3))),
    };
    descriptor = newDescriptor;
    const total = await session.addClient(state.client, newDescriptor);
    api = session;
    connected = true;
    setStatus("Status: connected");
    logLine(`${LOG_PREFIX} connected (${total} clients)`);
    return true;
  } catch (error) {
    logLine(`${LOG_PREFIX} connection failed: ${String(error)}`);
    setStatus("Status: disconnected");
    connected = false;
    api = null;
    return false;
  }
}

async function callRunCommand(command: string, clientId?: string): Promise<void> {
  if (!api) await ensureConnection();
  if (!api) {
    logLine(`${LOG_PREFIX} cannot send command; not connected`);
    return;
  }
  try {
    const response = await api.runCommand(command, clientId);
    logLine(`${LOG_PREFIX} command response: ${safeJson(response)}`);
    // if response lists audio files, reflect
    const files = getAudioFilesFromResponse(response);
    if (files) ui?.ui_set_audio_files?.(files);
  } catch (error) {
    logLine(`${LOG_PREFIX} command error: ${String(error)}`);
  }
}

async function callBroadcast(message: unknown): Promise<void> {
  if (!api) await ensureConnection();
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
    void ensureConnection().then((ok) => {
      if (ok) void callRunCommand("audio list");
    });
  },
  refreshStatus(): void {
    void callRunCommand("status");
  },
  fetchFiles(): void {
    void callRunCommand("files");
  },
  showPeers(): void {
    void callRunCommand("peers");
  },
  sendCommand(command: string): void {
    void callRunCommand(command);
  },
  playAudio(filename: string): void {
    if (!filename) return;
    const url = toHttpUrl(`/audio/${encodeURIComponent(filename)}`);
    logLine(`${LOG_PREFIX} playing audio ${url}`);
    playAudio(url);
    void callRunCommand(`play ${filename}`);
  },
  broadcastMessage(message: string): void {
    void callBroadcast({ type: "broadcast-message", message });
  },
  broadcastPlay(filename: string): void {
    void callBroadcast({ type: "play-audio", filename, from: descriptor?.id ?? null });
  },
  listAudioFiles(): void {
    void callRunCommand("audio list");
  },
  setHost(url: string): void {
    setHost(url);
  },
};

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function getAudioFilesFromResponse(resp: unknown): AudioItem[] | null {
  if (!resp || typeof resp !== "object") return null;
  const obj = resp as any;
  if (Array.isArray(obj.files)) return normalizeAudioList(obj.files);
  if (Array.isArray(obj.audioFiles)) return normalizeAudioList(obj.audioFiles);
  return null;
}

function normalizeAudioList(raw: unknown[]): AudioItem[] {
  return raw
    .map((item) => {
      if (typeof item === "string") {
        return { name: item } satisfies AudioItem;
      }
      if (item && typeof item === "object" && typeof (item as any).name === "string") {
        const candidate = item as { name: string; size?: number; uploaded?: string };
        return {
          name: candidate.name,
          size: candidate.size,
          uploaded: candidate.uploaded,
          source: "r2",
        } satisfies AudioItem;
      }
      return null;
    })
    .filter((item): item is AudioItem => item !== null);
}

export type { HubApi };
