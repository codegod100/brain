import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";

const PROJECT_FILES = [
    ".gitignore",
    "client.ts",
    "package.json",
    "pnpm-lock.yaml",
    "worker.ts",
    "wrangler.jsonc",
];

type ClientCallback = {
    broadcast(message: unknown): Promise<void> | void;
};

type ClientInfo = {
    id: string;
    joinedAt: string;
    vector: number[];
};

type ClientRecord = {
    stub: RpcStub<ClientCallback>;
    info: ClientInfo;
};

function isClientInfo(value: unknown): value is ClientInfo {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.id === "string" &&
        typeof candidate.joinedAt === "string" &&
        Array.isArray(candidate.vector) &&
        candidate.vector.every((item) => typeof item === "number")
    );
}

type Env = {
    RPC_HUB: DurableObjectNamespace;
    AUDIO_BUCKET: R2Bucket;
};

class HubApi extends RpcTarget {
    private clients: ClientRecord[] = [];
    private readonly commands = ["help", "storage", "put", "get", "delete", "keys", "expire", "ttl", "peers", "whoami", "broadcast", "audio"] as const;
    private readonly files = [...PROJECT_FILES];
    private state?: DurableObjectState;

    async addClient(stub: RpcStub<ClientCallback>, rawInfo: unknown) {
        if (!isClientInfo(rawInfo)) {
            throw new TypeError("Client descriptor is missing required fields");
        }

        const info = HubApi.cloneInfo(rawInfo);
        const dup = stub.dup();
        const record: ClientRecord = { stub: dup, info };
        const nearest = this.findClosest(info);
        dup.onRpcBroken((error) => {
            console.log("Client stub broken", error);
            this.removeClient(dup);
        });
        this.clients.push(record);
        console.log(`Registered client; total clients: ${this.clients.length}`);

        try {
            await dup.broadcast({
                type: "client-list",
                clients: this.clients.map((client) => HubApi.cloneInfo(client.info)),
                match: nearest
                    ? {
                          peer: HubApi.cloneInfo(nearest.record.info),
                          distance: nearest.distance,
                      }
                    : null,
                commands: this.listCommands(),
            });
        } catch (error) {
            console.error("Failed to deliver client list", error);
            this.removeClient(dup);
            throw error;
        }

        if (nearest) {
            try {
                await nearest.record.stub.broadcast({
                    type: "client-match",
                    client: HubApi.cloneInfo(info),
                    distance: nearest.distance,
                    message: "hello",
                });
            } catch (error) {
                console.error("Failed to notify matched client", error);
            }
        }

        await this.broadcast({
            type: "client-joined",
            client: HubApi.cloneInfo(info),
            total: this.clients.length,
        });

        return this.clients.length;
    }

    removeClient(stub: RpcStub<ClientCallback>) {
        const index = this.clients.findIndex(({ stub: candidate }) => candidate === stub);
        if (index !== -1) {
            const [record] = this.clients.splice(index, 1);
            try {
                record.stub[Symbol.dispose]();
            } catch (error) {
                console.warn("Failed to dispose client stub", error);
            }
            this.broadcast({
                type: "client-left",
                client: HubApi.cloneInfo(record.info),
                total: this.clients.length,
            }).catch((error) => console.error("Failed to broadcast leave", error));
        }
        console.log(`Remaining clients: ${this.clients.length}`);
    }

    async broadcast(message: unknown) {
        if (this.clients.length === 0) {
            return 0;
        }

        console.log(`Broadcasting to ${this.clients.length} client(s)`);
        const snapshot = [...this.clients];
        await Promise.all(
            snapshot.map(async ({ stub }) => {
                try {
                    await stub.broadcast(message);
                } catch (error) {
                    console.error("Client broadcast failed", error);
                    if (
                        error instanceof Error &&
                        (error.message.includes("stub after it has been disposed") ||
                            error.message.includes("Cannot perform I/O on behalf of a different request"))
                    ) {
                        this.removeClient(stub);
                    }
                }
            }),
        );
        return this.clients.length;
    }

    async runCommand(command: string, clientId?: string) {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        
        switch (cmd) {
            case "help":
                return {
                    command: "help",
                    data: this.listCommands(),
                };
            case "storage":
                // This will only work if the Durable Object is using SQLite storage backend
                // and the compatibility flag 'nodejs_compat' is enabled
                try {
                    // List all stored keys (up to 1000)
                    const storageList = await this.state.storage.list({ limit: 1000 });
                    const keys = Array.from(storageList.keys());
                    
                    return {
                        command: "storage",
                        data: {
                            keys,
                            count: keys.length,
                            databaseSize: this.state.storage.sql.databaseSize
                        }
                    };
                } catch (error) {
                    return {
                        command: "storage",
                        error: `Failed to read storage: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "put":
                // Parse command arguments: "put key value [ttl]"
                if (parts.length < 3) {
                    return {
                        command: "put",
                        error: "Usage: put <key> <value> [ttl_seconds]",
                        example: "put mykey myvalue 3600"
                    };
                }
                const key = parts[1];
                const value = parts[2];
                const ttlSeconds = parts.length > 3 ? parseInt(parts[3]) : null;
                
                try {
                    const data = { value, expiresAt: ttlSeconds ? Date.now() + (ttlSeconds * 1000) : null };
                    await this.state!.storage.put(key, JSON.stringify(data));
                    
                    // Set alarm for expiration if TTL provided
                    if (ttlSeconds) {
                        await (this as any).scheduleAlarmForExpiration(Date.now() + (ttlSeconds * 1000));
                    }
                    
                    return {
                        command: "put",
                        success: true,
                        key,
                        value,
                        ttl: ttlSeconds,
                        expiresAt: ttlSeconds ? new Date(Date.now() + (ttlSeconds * 1000)).toISOString() : null,
                        message: ttlSeconds ? `Key expires in ${ttlSeconds} seconds` : "Key has no expiration"
                    };
                } catch (error) {
                    return {
                        command: "put",
                        error: `Failed to store data: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "get":
                // Parse command arguments: "get key"
                if (parts.length < 2) {
                    return {
                        command: "get",
                        error: "Usage: get <key>",
                        example: "get mykey"
                    };
                }
                const getKey = parts[1];
                
                try {
                    const rawData = await this.state!.storage.get(getKey);
                    if (!rawData) {
                        return {
                            command: "get",
                            key: getKey,
                            value: null
                        };
                    }
                    
                    const data = JSON.parse(rawData as string);
                    
                    // Check if expired
                    if (data.expiresAt && Date.now() > data.expiresAt) {
                        // Key expired, delete it
                        await this.state!.storage.delete(getKey);
                        return {
                            command: "get",
                            key: getKey,
                            value: null,
                            expired: true
                        };
                    }
                    
                    return {
                        command: "get",
                        key: getKey,
                        value: data.value
                    };
                } catch (error) {
                    return {
                        command: "get",
                        error: `Failed to retrieve data: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "delete":
                // Parse command arguments: "delete key"
                if (parts.length < 2) {
                    return {
                        command: "delete",
                        error: "Usage: delete <key>",
                        example: "delete mykey"
                    };
                }
                const deleteKey = parts[1];
                
                try {
                    const deleted = await this.state!.storage.delete(deleteKey);
                    return {
                        command: "delete",
                        key: deleteKey,
                        deleted
                    };
                } catch (error) {
                    return {
                        command: "delete",
                        error: `Failed to delete data: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "keys":
                // List all keys (similar to Redis KEYS command)
                try {
                    const storageList = await this.state!.storage.list({ limit: 1000 });
                    const keys = Array.from(storageList.keys());
                    
                    return {
                        command: "keys",
                        keys,
                        count: keys.length
                    };
                } catch (error) {
                    return {
                        command: "keys",
                        error: `Failed to list keys: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "expire":
                // Parse command arguments: "expire key seconds"
                if (parts.length < 3) {
                    return {
                        command: "expire",
                        error: "Usage: expire <key> <seconds>",
                        example: "expire mykey 3600"
                    };
                }
                const expireKey = parts[1];
                const expireSeconds = parseInt(parts[2]);
                
                if (isNaN(expireSeconds) || expireSeconds <= 0) {
                    return {
                        command: "expire",
                        error: "TTL must be a positive number"
                    };
                }
                
                try {
                    const rawData = await this.state!.storage.get(expireKey);
                    if (!rawData) {
                        return {
                            command: "expire",
                            key: expireKey,
                            success: false,
                            error: "Key not found"
                        };
                    }
                    
                    const data = JSON.parse(rawData as string);
                    data.expiresAt = Date.now() + (expireSeconds * 1000);
                    
                    await this.state!.storage.put(expireKey, JSON.stringify(data));
                    await (this as any).scheduleAlarmForExpiration(data.expiresAt);
                    
                    return {
                        command: "expire",
                        key: expireKey,
                        ttl: expireSeconds,
                        success: true,
                        expiresAt: new Date(data.expiresAt).toISOString(),
                        message: `Key will expire in ${expireSeconds} seconds`
                    };
                } catch (error) {
                    return {
                        command: "expire",
                        error: `Failed to set expiration: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "ttl":
                // Parse command arguments: "ttl key"
                if (parts.length < 2) {
                    return {
                        command: "ttl",
                        error: "Usage: ttl <key>",
                        example: "ttl mykey"
                    };
                }
                const ttlKey = parts[1];
                
                try {
                    const rawData = await this.state!.storage.get(ttlKey);
                    if (!rawData) {
                        return {
                            command: "ttl",
                            key: ttlKey,
                            ttl: -2  // Key doesn't exist
                        };
                    }
                    
                    const data = JSON.parse(rawData as string);
                    
                    if (!data.expiresAt) {
                        return {
                            command: "ttl",
                            key: ttlKey,
                            ttl: -1,
                            message: "Key has no expiration set"
                        };
                    }
                    
                    const remainingMs = data.expiresAt - Date.now();
                    const remainingSeconds = Math.ceil(remainingMs / 1000);
                    
                    if (remainingSeconds <= 0) {
                        // Key expired, clean it up
                        await this.state!.storage.delete(ttlKey);
                        return {
                            command: "ttl",
                            key: ttlKey,
                            ttl: -2,
                            message: "Key has expired and was deleted"
                        };
                    }
                    
                    return {
                        command: "ttl",
                        key: ttlKey,
                        ttl: remainingSeconds,
                        message: `Key expires in ${remainingSeconds} seconds`
                    };
                } catch (error) {
                    return {
                        command: "ttl",
                        error: `Failed to get TTL: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "peers":
                // Show connected clients
                const peerInfo = this.clients.map(client => ({
                    id: client.info.id,
                    joinedAt: client.info.joinedAt,
                    vector: client.info.vector,
                    isMe: client.info.id === clientId
                }));
                
                return {
                    command: "peers",
                    count: this.clients.length,
                    peers: peerInfo,
                    yourId: clientId
                };
            case "whoami":
                // Show information about the current connection
                const clientInfo = clientId ? this.clients.find(c => c.info.id === clientId) : null;
                
                return {
                    command: "whoami",
                    clientId: clientId || "unknown",
                    message: "You are connected to the Brain Hub",
                    serverTime: new Date().toISOString(),
                    totalPeers: this.clients.length,
                    storageKeys: (await this.state!.storage.list({ limit: 1000 })).size,
                    uptime: "Running on Cloudflare Durable Objects",
                    ...(clientInfo && {
                        joinedAt: clientInfo.info.joinedAt,
                        vector: clientInfo.info.vector
                    })
                };
            case "broadcast":
                // Parse command arguments: "broadcast message"
                if (parts.length < 2) {
                    return {
                        command: "broadcast",
                        error: "Usage: broadcast <message>",
                        example: "broadcast Hello everyone!"
                    };
                }
                const message = parts.slice(1).join(" ");
                
                try {
                    // Broadcast the message to all clients
                    const broadcastResult = await this.broadcast({
                        type: "user-message",
                        from: clientId,
                        message: message,
                        timestamp: new Date().toISOString()
                    });
                    
                    return {
                        command: "broadcast",
                        message: message,
                        recipients: broadcastResult,
                        from: clientId
                    };
                } catch (error) {
                    return {
                        command: "broadcast",
                        error: `Failed to broadcast: ${error instanceof Error ? error.message : String(error)}`
                    };
                }
            case "audio":
                // Parse command arguments: "audio list" or "audio get <filename>"
                if (parts.length < 2) {
                    return {
                        command: "audio",
                        error: "Usage: audio <list|get> [filename]",
                        example: "audio list"
                    };
                }
                
                const audioAction = parts[1];
                
                if (audioAction === "list") {
                    try {
                        // List objects in R2 bucket
                        const objects = await (this as any).env.AUDIO_BUCKET.list();
                        const files = objects.objects.map((obj: any) => ({
                            name: obj.key,
                            size: obj.size,
                            uploaded: obj.uploaded.toISOString()
                        }));
                        
                        return {
                            command: "audio",
                            action: "list",
                            files,
                            count: files.length
                        };
                    } catch (error) {
                        return {
                            command: "audio",
                            error: `Failed to list audio files: ${error instanceof Error ? error.message : String(error)}`
                        };
                    }
                } else if (audioAction === "get") {
                    if (parts.length < 3) {
                        return {
                            command: "audio",
                            error: "Usage: audio get <filename>",
                            example: "audio get song.mp3"
                        };
                    }
                    
                    const filename = parts[2];
                    
                    try {
                        // Generate a signed URL for the audio file
                        const object = await (this as any).env.AUDIO_BUCKET.get(filename);
                        
                        if (!object) {
                            return {
                                command: "audio",
                                action: "get",
                                filename,
                                error: "Audio file not found"
                            };
                        }
                        
                        // Return the object info with a playable URL
                        // For now, we'll return the metadata - in a real app you'd generate signed URLs
                        // or serve the audio through the worker
                        return {
                            command: "audio",
                            action: "get",
                            filename,
                            key: filename,
                            size: object.size,
                            contentType: object.httpMetadata?.contentType,
                            exists: true,
                            url: `http://localhost:8787/audio/${filename}`, // Placeholder URL
                            message: "Audio file found. Use a media player to stream from R2."
                        };
                    } catch (error) {
                        return {
                            command: "audio",
                            error: `Failed to get audio file: ${error instanceof Error ? error.message : String(error)}`
                        };
                    }
                } else if (audioAction === "upload") {
                    if (parts.length < 4) {
                        return {
                            command: "audio",
                            error: "Usage: audio upload <filename> <base64data>",
                            example: "audio upload song.mp3 <base64-encoded-file-data>"
                        };
                    }
                    
                    const uploadFilename = parts[2];
                    const base64Data = parts.slice(3).join(" ");
                    
                    try {
                        // Decode base64 data
                        const fileData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
                        
                        // Upload to R2
                        await (this as any).env.AUDIO_BUCKET.put(uploadFilename, fileData, {
                            httpMetadata: {
                                contentType: uploadFilename.endsWith('.mp3') ? 'audio/mpeg' :
                                           uploadFilename.endsWith('.wav') ? 'audio/wav' :
                                           uploadFilename.endsWith('.ogg') ? 'audio/ogg' :
                                           'application/octet-stream'
                            }
                        });
                        
                        return {
                            command: "audio",
                            action: "upload",
                            filename: uploadFilename,
                            size: fileData.length,
                            success: true
                        };
                    } catch (error) {
                        return {
                            command: "audio",
                            error: `Failed to upload audio file: ${error instanceof Error ? error.message : String(error)}`
                        };
                    }
                }
            default:
                return {
                    command: cmd,
                    error: `Unknown command: ${cmd}`,
                    available: this.listCommands(),
                };
        }
    }

    private findClosest(info: ClientInfo) {
        let best: { record: ClientRecord; distance: number } | undefined;
        for (const record of this.clients) {
            const distance = HubApi.distance(info.vector, record.info.vector);
            if (!Number.isFinite(distance)) continue;
            if (!best || distance < best.distance) {
                best = { record, distance };
            }
        }
        return best;
    }

    private static distance(a: number[], b: number[]) {
        const length = Math.min(a.length, b.length);
        if (length === 0) return Number.POSITIVE_INFINITY;
        let sum = 0;
        for (let i = 0; i < length; i += 1) {
            const diff = a[i] - b[i];
            sum += diff * diff;
        }
        const dimensionPenalty = Math.abs(a.length - b.length);
        return Math.sqrt(sum) + dimensionPenalty;
    }

    private static cloneInfo(info: ClientInfo): ClientInfo {
        return {
            id: info.id,
            joinedAt: info.joinedAt,
            vector: [...info.vector],
        };
    }

    private listCommands() {
        return [...this.commands];
    }
}

export class RpcHub {
    private readonly api = new HubApi();
    private broadcastInterval?: ReturnType<typeof setInterval>;

    constructor(private readonly state: DurableObjectState, private readonly env: Env) {
        // Pass the state and env to the HubApi so it can access storage and R2
        (this.api as any).state = state;
        (this.api as any).env = env;
        (this.api as any).scheduleAlarmForExpiration = this.scheduleAlarmForExpiration.bind(this);
        this.ensureTimer();
    }

    async fetch(request: Request) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
            return new Response("This endpoint only accepts WebSocket requests.", {
                status: 400,
            });
        }

        const pair = new WebSocketPair();
        const [clientSocket, serverSocket] = Object.values(pair) as [WebSocket, WebSocket];
        serverSocket.accept();
        newWebSocketRpcSession(serverSocket, this.api);

        return new Response(null, {
            status: 101,
            webSocket: clientSocket,
        });
    }

    async handleAlarm() {
        // Clean up expired keys when alarm fires
        try {
            const storageList = await this.state.storage.list({ limit: 1000 });
            const now = Date.now();
            let cleanedCount = 0;
            
            for (const [key, rawData] of storageList) {
                try {
                    const data = JSON.parse(rawData as string);
                    if (data.expiresAt && now > data.expiresAt) {
                        await this.state.storage.delete(key);
                        cleanedCount++;
                    }
                } catch (e) {
                    // Skip invalid JSON
                }
            }
            
            console.log(`Cleaned up ${cleanedCount} expired keys`);
            
            // Check if there are more alarms to set
            await this.scheduleNextAlarm();
        } catch (error) {
            console.error("Failed to clean up expired keys:", error);
        }
    }

    async alarm() {
        // This method is required for Durable Objects that use setAlarm()
        await this.handleAlarm();
    }

    private async scheduleAlarmForExpiration(newExpiration: number) {
        try {
            // Check current alarm time
            const currentAlarm = await this.state.storage.getAlarm();
            
            // Set alarm if: no current alarm, or new expiration is earlier
            if (!currentAlarm || newExpiration < currentAlarm) {
                await this.state.storage.setAlarm(newExpiration);
            }
        } catch (error) {
            console.error("Failed to schedule alarm:", error);
        }
    }

    private async scheduleNextAlarm() {
        // Find the next expiration time and set alarm
        try {
            const storageList = await this.state!.storage.list({ limit: 1000 });
            let nextExpiration: number | null = null;
            
            for (const [key, rawData] of storageList) {
                try {
                    const data = JSON.parse(rawData as string);
                    if (data.expiresAt && (!nextExpiration || data.expiresAt < nextExpiration)) {
                        nextExpiration = data.expiresAt;
                    }
                } catch (e) {
                    // Skip invalid JSON
                }
            }
            
            if (nextExpiration) {
                await this.state!.storage.setAlarm(nextExpiration);
            }
        } catch (error) {
            console.error("Failed to schedule next alarm:", error);
        }
    }

    private ensureTimer() {
        if (this.broadcastInterval) return;
        this.broadcastInterval = setInterval(() => {
            this.api
                .broadcast(new Date().toISOString())
                .catch((error) => console.error("Scheduled broadcast failed", error));
        }, 10_000);
    }
}

// Main fetch handler for serving audio files and WebSocket connections
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        
        // Handle audio file requests
        if (url.pathname.startsWith('/audio/')) {
            const filename = url.pathname.slice(7); // Remove '/audio/' prefix
            
            try {
                const object = await env.AUDIO_BUCKET.get(filename);
                
                if (!object) {
                    return new Response('Audio file not found', { status: 404 });
                }
                
                // Return the audio file with appropriate headers
                return new Response(object.body, {
                    headers: {
                        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
                        'Content-Length': object.size.toString(),
                        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
                    },
                });
            } catch (error) {
                console.error('Error serving audio file:', error);
                return new Response('Internal server error', { status: 500 });
            }
        }
        
        // Handle WebSocket upgrades for RPC
        if (request.headers.get('Upgrade') === 'websocket') {
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader !== 'websocket') {
                return new Response('Expected Upgrade: websocket', { status: 426 });
            }
            
            // Get the Durable Object ID and stub
            const id = env.RPC_HUB.idFromName('hub');
            const stub = env.RPC_HUB.get(id);
            
            // Forward the request to the Durable Object
            return stub.fetch(request);
        }
        
        return new Response('Not found', { status: 404 });
    },
};
