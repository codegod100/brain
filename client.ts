import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import net from "node:net";
import player from "play-sound";

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let host = "ws://localhost:8787";
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--host" || arg === "-h") {
      if (i + 1 < args.length) {
        host = args[i + 1];
        i++; // Skip next arg
      } else {
        console.error("Error: --host requires a value");
        process.exit(1);
      }
    } else if (arg === "--help") {
      console.log("Usage: node client.ts [options]");
      console.log("Options:");
      console.log("  --host, -h <host>    WebSocket host to connect to (default: ws://localhost:8787)");
      console.log("  --help               Show this help message");
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Use --help for usage information");
      process.exit(1);
    }
  }
  
  return { host };
}

const { host } = parseArgs();
const CONTROL_HOST = process.env.CLIENT_HTTP_HOST ?? "127.0.0.1";
const CONTROL_PORT = Number.parseInt(process.env.CLIENT_HTTP_PORT ?? "4455", 10);
const CONTROL_SOCKET_PORT = Number.parseInt(process.env.CLIENT_SOCKET_PORT ?? String(CONTROL_PORT), 10);

const socketClients = new Set<net.Socket>();
const socketBuffers = new Map<net.Socket, string>();

type ClientDescriptor = {
  id: string;
  joinedAt: string;
  vector: number[];
};

class Client extends RpcTarget {
  broadcast(message: unknown) {
    if (typeof message === "string") {
      console.log(`Incoming message! ${message}`);
      broadcastSocketEvent('hub-message', { message, format: 'string' });
    } else if (typeof message === "object" && message !== null) {
      const msg = message as any;
      if (msg.type === "play-audio" && msg.filename) {
        // Don't play if this broadcast is from ourselves
        if (msg.from === descriptor.id) {
          console.log(`🎵 You initiated audio broadcast: ${msg.filename}`);
          broadcastSocketEvent('broadcast-play', {
            filename: msg.filename,
            from: msg.from ?? descriptor.id,
            timestamp: msg.timestamp ?? new Date().toISOString(),
            self: true,
          });
          return;
        }
        console.log(`🎵 Incoming audio broadcast: ${msg.filename} from ${msg.from || 'unknown'}`);
        broadcastSocketEvent('broadcast-play', {
          filename: msg.filename,
          from: msg.from ?? null,
          timestamp: msg.timestamp ?? new Date().toISOString(),
          self: false,
        });
        // Construct the audio URL based on our host
        const httpHost = host.replace(/^ws/, 'http');
        const audioUrl = `${httpHost}/audio/${msg.filename}`;
        // Play the audio asynchronously
        playAudio(audioUrl, msg.filename).catch(err => {
          console.error(`Failed to play broadcasted audio: ${err}`);
        });
        return;
      }
      try {
        console.log("Incoming message!\n" + JSON.stringify(message, null, 2));
      } catch (error) {
        console.log("Incoming message!", message);
      }
      broadcastSocketEvent('hub-message', { message, format: 'object' });
    } else {
      console.log("Incoming message!", message);
      broadcastSocketEvent('hub-message', { message, format: 'unknown' });
    }
  }
}

type HubApi = {
  addClient(stub: Client, descriptor: ClientDescriptor): Promise<number>;
  broadcast(message: unknown): Promise<number>;
  runCommand(command: string, clientId?: string): Promise<unknown>;
};

type SocketRequest = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

type SocketResponse = {
  id?: string;
  type: string;
  ok?: boolean;
  error?: string;
  data?: unknown;
  event?: string;
  payload?: unknown;
};

const api = newWebSocketRpcSession<HubApi>(host);
const descriptor: ClientDescriptor = {
  id: randomUUID(),
  joinedAt: new Date().toISOString(),
  vector: Array.from({ length: 3 }, () => Number.parseFloat(Math.random().toFixed(3))),
};

const client = new Client();
const total = await api.addClient(client, descriptor);
console.log(`Connected to: ${host}`);
console.log(`Connected clients: ${total}`);
console.log('Commands available: type "files" or "help"; "exit" to quit.');

let socketStarted = false;
try {
  socketStarted = await startSocketInterface();
  if (socketStarted) {
    console.log(`Control interface listening at tcp://${CONTROL_HOST}:${CONTROL_SOCKET_PORT}`);
  } else {
    console.warn(`Control interface disabled; port ${CONTROL_SOCKET_PORT} already in use`);
  }
} catch (error) {
  console.error(
    `[SOCKET] failed to start interface: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const rl = createInterface({ input: stdin, output: stdout });

// Audio playback function
async function playAudio(url: string, filename: string) {
  console.log(`🎵 Downloading and playing: ${filename}`);
  console.log(`   URL: ${url}`);
  
  try {
    // Download the audio file to a temporary location
    const tempPath = `/tmp/${filename}`;
    const file = fs.createWriteStream(tempPath);
    
    const protocol = url.startsWith('https:') ? https : http;
    
    await new Promise((resolve, reject) => {
      protocol.get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(undefined);
        });
      }).on('error', reject);
    });
    
    console.log(`   Downloaded to: ${tempPath}`);
    
    // Play the audio file
    const audioPlayer = player();
    audioPlayer.play(tempPath, (err: any) => {
      if (err) {
        console.error('Error playing audio:', err);
      } else {
        console.log('   Playback finished');
      }
      
      // Clean up temp file
      try {
        fs.unlinkSync(tempPath);
        console.log('   Cleaned up temporary file');
      } catch (cleanupErr) {
        console.warn('   Failed to clean up temp file:', cleanupErr);
      }
    });
    
  } catch (error) {
    console.error('Failed to play audio:', error);
  }
}

// Main command loop

try {
  for await (const line of rl) {
    const command = line.trim();
    if (!command) {
      continue;
    }
    if (command === "files") {
      try {
        const files = fs.readdirSync('.');
        console.log("Local files:\n" + JSON.stringify(files, null, 2));
      } catch (error) {
        console.error("Failed to read files", error);
      }
      continue;
    }
    if (command.startsWith("upload ")) {
      const parts = command.split(" ");
      if (parts.length >= 3) {
        const localPath = parts[1];
        const remoteFilename = parts[2];
        
        try {
          // Read the local file
          const fileData = fs.readFileSync(localPath);
          // Encode as base64
          const base64Data = fileData.toString('base64');
          
          // Upload via worker HTTP endpoint
          const response = await uploadFileViaHttp(remoteFilename, base64Data, guessContentType(remoteFilename));
          console.log("Upload response:\n" + JSON.stringify(response, null, 2));
        } catch (error) {
          console.error("Failed to upload file", error);
        }
      } else {
        console.error("Usage: upload <local-path> <remote-filename>");
      }
      continue;
    }
    if (command.startsWith("broadcast-play ")) {
      const audioFile = command.slice(14).trim();
      if (audioFile) {
        try {
          // First check if the audio file exists
          const audioResponse = await api.runCommand(`audio get ${audioFile}`, descriptor.id) as any;
          if (audioResponse.exists) {
            console.log(`🎵 Broadcasting audio: ${audioFile} to all peers`);
            
            // Broadcast the play command to all clients
            const broadcastMessage = {
              type: "play-audio",
              filename: audioFile,
              from: descriptor.id,
              timestamp: new Date().toISOString()
            };
            
            await api.broadcast(broadcastMessage);
            console.log("Broadcast sent!");
            
            // Also play it locally
            const httpHost = host.replace(/^ws/, 'http');
            const audioUrl = `${httpHost}/audio/${audioFile}`;
            await playAudio(audioUrl, audioFile);
          } else {
            console.error("Audio file not found");
          }
        } catch (error) {
          console.error("Failed to broadcast audio", error);
        }
      } else {
        console.error("Usage: broadcast-play <filename>");
      }
      continue;
    }
    if (command.startsWith("play ")) {
      const audioFile = command.slice(5).trim();
      if (audioFile) {
        try {
          // First get the audio info
          const audioResponse = await api.runCommand(`audio get ${audioFile}`, descriptor.id) as any;
          if (audioResponse.exists) {
            console.log(`🎵 Audio file found: ${audioFile}`);
            console.log(`   Size: ${audioResponse.size} bytes`);
            console.log(`   Type: ${audioResponse.contentType || 'unknown'}`);
            
            // Construct the audio URL based on the host we're connected to
            // Convert ws:// or wss:// to http:// or https://
            const httpHost = host.replace(/^ws/, 'http');
            const audioUrl = `${httpHost}/audio/${audioFile}`;
            
            // Play the audio
            await playAudio(audioUrl, audioFile);
          } else {
            console.error("Audio file not found");
          }
        } catch (error) {
          console.error("Failed to get audio info", error);
        }
      } else {
        console.error("Usage: play <filename>");
      }
      continue;
    }
    if (command === "exit" || command === "quit") {
      break;
    }

    try {
      const response = await api.runCommand(command, descriptor.id);
      console.log("Command response:\n" + JSON.stringify(response, null, 2));
    } catch (error) {
      console.error("Command failed", error);
    }
  }
} finally {
  rl.close();
}

async function safeRunCommand(command: string) {
  try {
    return await api.runCommand(command, descriptor.id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function getStatusPayload() {
  const whoami = await safeRunCommand("whoami");
  const audioList = await safeRunCommand("audio list");
  return {
    host,
    descriptor,
    connected: true,
    timestamp: new Date().toISOString(),
    whoami,
    audioList,
  };
}

async function listFilesPayload() {
  const files = await fs.promises.readdir(".");
  return { files };
}

async function commandPayload(command: string) {
  const result = await api.runCommand(command, descriptor.id);
  return { result };
}

async function playPayload(filename: string) {
  const info = await getAudioInfo(filename);
  if (!info || !info.exists) {
    throw new Error("Audio file not found");
  }
  await playAudio(buildAudioUrl(filename), filename);
  return { played: filename, info };
}

async function broadcastPayload(message: string) {
  const payload = {
    type: "user-message",
    from: descriptor.id,
    message,
    timestamp: new Date().toISOString(),
  };
  const recipients = await api.broadcast(payload);
  return { recipients, payload };
}

async function broadcastPlayPayload(filename: string) {
  const info = await getAudioInfo(filename);
  if (!info || !info.exists) {
    throw new Error("Audio file not found");
  }
  const message = {
    type: "play-audio",
    filename,
    from: descriptor.id,
    timestamp: new Date().toISOString(),
  };
  await api.broadcast(message);
  await playAudio(buildAudioUrl(filename), filename);
  return { broadcast: true, filename, info };
}

async function uploadPayload(filename: string, base64: string, contentType?: string) {
  const normalizedContentType = contentType ?? guessContentType(filename);
  try {
    return await uploadFileViaHttp(filename, base64, normalizedContentType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[HTTP] upload http fallback ${new Date().toISOString()} reason=${message}`);
    return await uploadFileViaCommand(filename, base64, normalizedContentType);
  }
}

function buildAudioUrl(filename: string) {
  const base = host.startsWith("wss") ? host.replace(/^wss/, "https") : host.replace(/^ws/, "http");
  return `${base}/audio/${filename}`;
}

async function getAudioInfo(filename: string) {
  return (await api.runCommand(`audio get ${filename}`, descriptor.id)) as any;
}

function guessContentType(path: string) {
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".ogg")) return "audio/ogg";
  if (path.endsWith(".flac")) return "audio/flac";
  if (path.endsWith(".m4a")) return "audio/mp4";
  return "application/octet-stream";
}

async function uploadFileViaHttp(filename: string, base64: string, contentType: string) {
  const uploadUrl = new URL("/upload", buildAudioUrl(""));
  uploadUrl.pathname = "/upload";
  const body = JSON.stringify({ filename, base64, contentType });
  const isHttps = uploadUrl.protocol === "https:";
  const requestFn = isHttps ? https.request : http.request;

  return new Promise<any>((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: uploadUrl.hostname,
      port: uploadUrl.port || (isHttps ? 443 : 80),
      path: uploadUrl.pathname + uploadUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
    };

    const req = requestFn(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(text));
          } catch (error) {
            reject(new Error(`Failed to parse upload response: ${error instanceof Error ? error.message : String(error)}`));
          }
        } else {
          reject(new Error(`HTTP ${status}: ${text || res.statusMessage || "Unknown error"}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function uploadFileViaCommand(filename: string, base64: string, contentType: string) {
  const sanitizedBase64 = typeof base64 === "string" ? base64.trim() : "";
  if (!sanitizedBase64) {
    throw new Error("base64 payload is empty");
  }
  const command = `audio upload ${filename} ${sanitizedBase64}`;
  const result = await api.runCommand(command, descriptor.id);
  if (!result || typeof result !== "object") {
    throw new Error("Unexpected response from audio upload command");
  }
  const payload = result as { error?: string; size?: number; filename?: string };
  if (payload.error) {
    throw new Error(payload.error);
  }
  const decoded = Buffer.from(sanitizedBase64, "base64");
  return {
    filename: payload.filename ?? filename,
    size: payload.size ?? decoded.length,
    contentType,
    via: "command",
  };
}

function sendSocket(socket: net.Socket, message: SocketResponse) {
  try {
    socket.write(JSON.stringify(message) + "\n");
  } catch (error) {
    console.error("[SOCKET] failed to send message", error instanceof Error ? error.message : String(error));
    socket.destroy();
  }
}

function broadcastSocketEvent(event: string, payload: unknown) {
  for (const socket of socketClients) {
    sendSocket(socket, { type: "event", event, payload });
  }
}

function removeSocket(socket: net.Socket) {
  socketClients.delete(socket);
  socketBuffers.delete(socket);
}

function handleSocketData(socket: net.Socket, chunk: string) {
  const previous = socketBuffers.get(socket) ?? "";
  const combined = previous + chunk;
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  socketBuffers.set(socket, remainder);
  for (const part of parts) {
    const line = part.trim();
    if (!line) continue;
    let request: SocketRequest;
    try {
      request = JSON.parse(line) as SocketRequest;
    } catch (error) {
      console.warn("[SOCKET] invalid JSON", error instanceof Error ? error.message : String(error));
      sendSocket(socket, { type: "error", ok: false, error: "invalid json" });
      continue;
    }
    void handleSocketRequest(socket, request);
  }
}

async function handleSocketRequest(socket: net.Socket, request: SocketRequest) {
  const { id, type } = request;
  if (!id || typeof id !== "string") {
    sendSocket(socket, { type: "error", ok: false, error: "request id is required" });
    return;
  }
  try {
    let data: unknown;
    switch (type) {
      case "status":
        data = await getStatusPayload();
        break;
      case "files":
        data = await listFilesPayload();
        break;
      case "command": {
        const command = typeof request.command === "string" ? request.command : undefined;
        if (!command) throw new Error("command is required");
        data = await commandPayload(command);
        break;
      }
      case "play": {
        const filename = typeof request.filename === "string" ? request.filename : undefined;
        if (!filename) throw new Error("filename is required");
        data = await playPayload(filename);
        break;
      }
      case "broadcast": {
        const message = typeof request.message === "string" ? request.message : undefined;
        if (!message) throw new Error("message is required");
        data = await broadcastPayload(message);
        break;
      }
      case "broadcast-play": {
        const filename = typeof request.filename === "string" ? request.filename : undefined;
        if (!filename) throw new Error("filename is required");
        data = await broadcastPlayPayload(filename);
        break;
      }
      case "upload": {
        const filename = typeof request.filename === "string" ? request.filename : undefined;
        const base64 = typeof request.base64 === "string" ? request.base64 : undefined;
        const contentType = typeof request.contentType === "string" ? request.contentType : undefined;
        if (!filename || !base64) throw new Error("filename and base64 are required");
        data = await uploadPayload(filename, base64, contentType);
        break;
      }
      default:
        throw new Error(`Unknown request type: ${String(type)}`);
    }
    sendSocket(socket, { id, type, ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendSocket(socket, { id, type, ok: false, error: message });
  }
}

async function startSocketInterface(): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socketClients.add(socket);
      socketBuffers.set(socket, "");
      console.log(`[SOCKET] client connected from ${socket.remoteAddress}:${socket.remotePort}`);
      sendSocket(socket, {
        type: "event",
        event: "hello",
        payload: {
          host,
          descriptor,
          connectedAt: new Date().toISOString(),
        },
      });
      void getStatusPayload()
        .then((status) => {
          sendSocket(socket, { type: "event", event: "status", payload: status });
        })
        .catch((error) => {
          sendSocket(socket, {
            type: "event",
            event: "error",
            payload: { message: error instanceof Error ? error.message : String(error) },
          });
        });
      socket.on("data", (chunk) => handleSocketData(socket, chunk));
      socket.on("close", () => {
        console.log("[SOCKET] client disconnected");
        removeSocket(socket);
      });
      socket.on("error", (error) => {
        console.error("[SOCKET] client error", error instanceof Error ? error.message : String(error));
        removeSocket(socket);
      });
    });

    const handleError = (error: NodeJS.ErrnoException) => {
      if (error && error.code === "EADDRINUSE") {
        console.warn(`[SOCKET] port ${CONTROL_HOST}:${CONTROL_SOCKET_PORT} already in use; skipping socket interface`);
        server.close();
        resolve(false);
        return;
      }
      reject(error);
    };

    server.once("error", handleError);
    server.listen(CONTROL_SOCKET_PORT, CONTROL_HOST, () => {
      server.off("error", handleError);
      server.on("error", (error) => {
        console.error("[SOCKET] server error", error instanceof Error ? error.message : String(error));
      });
      console.log(`[SOCKET] listening on tcp://${CONTROL_HOST}:${CONTROL_SOCKET_PORT}`);
      resolve(true);
    });
  });
}
