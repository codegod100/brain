import { RpcTarget, newWebSocketRpcSession } from "capnweb";

export type AudioItem = {
  name: string;
  size?: number;
  uploaded?: string;
  source?: string;
};

type BenchmarkResult = {
  clientId: string;
  durationMs: number;
  iterations: number;
  opsPerSecond?: number;
  receivedAt: string;
  details?: unknown;
};

type BenchmarkSummary = {
  command: 'benchmark';
  requestId: string;
  requesterId: string | null;
  iterations: number;
  timeoutMs: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  participants: number;
  responded: number;
  pending: string[];
  results: BenchmarkResult[];
  message: string;
};

type BenchmarkUpdate =
  | { kind: 'summary'; summary: BenchmarkSummary }
  | { kind: 'error'; error: string }
  | { kind: 'reset' };

export type UiBindings = {
  ui_append_log_line?: (line: string) => void;
  ui_set_status_text?: (text: string) => void;
  ui_set_log_lines?: (lines: string[]) => void;
  ui_set_audio_files?: (files: AudioItem[]) => void;
  ui_set_benchmark_result?: (update: BenchmarkUpdate) => void;
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

type BenchmarkRequestMessage = {
  type: 'benchmark-request';
  requestId: string;
  iterations?: number;
  requesterId?: string | null;
  timeoutMs?: number;
  startedAt?: string;
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
  return "ws://localhost:8787/ws";
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
    if (payload?.type === "benchmark-request") {
      void handleBenchmarkRequest(payload as BenchmarkRequestMessage);
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

async function callRunCommand(command: string, clientId: string | undefined = descriptor?.id ?? undefined): Promise<void> {
  const normalized = command.trim().toLowerCase();
  const isBenchmarkCommand = normalized.startsWith('benchmark') && !normalized.startsWith('benchmark report');
  if (!api) await ensureConnection();
  if (!api) {
    logLine(`${LOG_PREFIX} cannot send command; not connected`);
    if (isBenchmarkCommand) {
      ui?.ui_set_benchmark_result?.({ kind: 'error', error: 'Not connected to hub' });
    }
    return;
  }
  try {
    const response = await api.runCommand(command, clientId);
    logLine(`${LOG_PREFIX} command response: ${safeJson(response)}`);
    // if response lists audio files, reflect
    const files = getAudioFilesFromResponse(response);
    if (files) ui?.ui_set_audio_files?.(files);

    const summary = getBenchmarkSummaryFromResponse(response);
    if (summary) {
      ui?.ui_set_benchmark_result?.({ kind: 'summary', summary });
    } else if (isBenchmarkCommand) {
      const error = getBenchmarkErrorFromResponse(response);
      if (error) {
        ui?.ui_set_benchmark_result?.({ kind: 'error', error });
      }
    }
  } catch (error) {
    logLine(`${LOG_PREFIX} command error: ${String(error)}`);
    if (isBenchmarkCommand) {
      ui?.ui_set_benchmark_result?.({ kind: 'error', error: String(error) });
    }
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
  runBenchmark(command?: string | number): void {
    if (typeof command === 'number' && Number.isFinite(command)) {
      void callRunCommand(`benchmark ${Math.trunc(command)}`);
      return;
    }
    if (typeof command === 'string' && command.trim()) {
      void callRunCommand(command.trim());
      return;
    }
    void callRunCommand('benchmark');
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

function getBenchmarkSummaryFromResponse(resp: unknown): BenchmarkSummary | null {
  if (!resp || typeof resp !== 'object') return null;
  const candidate = resp as Record<string, unknown>;
  if (candidate.command !== 'benchmark') return null;
  if (!Array.isArray(candidate.results)) return null;
  return candidate as BenchmarkSummary;
}

function getBenchmarkErrorFromResponse(resp: unknown): string | null {
  if (!resp || typeof resp !== 'object') return null;
  const candidate = resp as Record<string, unknown>;
  if (candidate.command !== 'benchmark') return null;
  if (typeof candidate.error === 'string') return candidate.error;
  return null;
}

async function handleBenchmarkRequest(request: BenchmarkRequestMessage): Promise<void> {
  const defaultIterations = 50_000;
  const maxIterations = 5_000_000;
  const iterationsRaw = typeof request.iterations === 'number' && Number.isFinite(request.iterations)
    ? request.iterations
    : defaultIterations;
  const iterations = Math.min(Math.max(Math.trunc(iterationsRaw), 1), maxIterations);
  const logLabel = `${LOG_PREFIX} benchmark`;
  logLine(`${logLabel} request ${request.requestId} iterations=${iterations}`);

  const started = performance.now();
  // Simple CPU-bound benchmark: math operations in a loop
  let checksum = 0;
  for (let i = 0; i < iterations; i += 1) {
    checksum += Math.sin(i) + Math.cos(i / 2);
  }
  const durationMs = performance.now() - started;
  const opsPerSec = durationMs > 0 ? (iterations / durationMs) * 1000 : iterations;

  const payload = {
    iterations,
    opsPerSec,
    checksum,
    startedAt: request.startedAt ?? new Date().toISOString(),
    completedAt: new Date().toISOString(),
    timeoutMs: request.timeoutMs ?? null,
    clientId: descriptor?.id ?? null,
    userAgent: navigator.userAgent,
  };

  logLine(`${logLabel} ${request.requestId} completed in ${durationMs.toFixed(2)}ms (≈${opsPerSec.toFixed(0)} ops/s)`);

  try {
    await callRunCommand(
      `benchmark report ${request.requestId} ${durationMs.toFixed(3)} ${JSON.stringify(payload)}`,
    );
  } catch (error) {
    logLine(`${logLabel} failed to report: ${String(error)}`);
  }
}

export type { HubApi };
