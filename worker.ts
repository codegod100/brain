import { Buffer, type BufferEncoding } from "node:buffer";
import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const randomRequestId = () =>
    typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

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

type BenchmarkResult = {
    clientId: string;
    durationMs: number;
    iterations: number;
    opsPerSecond?: number;
    receivedAt: string;
    details?: unknown;
};

type PendingBenchmark = {
    requestId: string;
    requesterId: string | null;
    createdAt: number;
    iterations: number;
    timeoutMs: number;
    expected: Set<string>;
    results: BenchmarkResult[];
    resolve: (summary: BenchmarkSummary) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
};

type BenchmarkSummary = {
    command: "benchmark";
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

type MapReduceReducer = "collect" | "sum" | "average" | "concat" | "count" | "merge";

type MapReduceTaskDescriptor = {
    taskId: string;
    payload: unknown;
    metadata?: Record<string, unknown> | null;
};

type MapReduceTaskState = MapReduceTaskDescriptor & {
    assignedTo?: string;
    assignedAt?: number;
    attempts: number;
    completedAt?: number;
    result?: unknown;
    error?: string;
    resultMetadata?: unknown;
};

type MapReduceResultEntry = {
    taskId: string;
    assignedTo?: string;
    attempts: number;
    durationMs?: number;
    result?: unknown;
    error?: string;
    metadata?: unknown;
};

type PendingMapReduce = {
    requestId: string;
    requesterId: string | null;
    createdAt: number;
    timeoutMs: number;
    reducer: MapReduceReducer;
    tasks: MapReduceTaskState[];
    resolve: (summary: MapReduceSummary) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
    nextClientIndex: number;
};

type MapReduceSummary = {
    command: "mapreduce";
    requestId: string;
    requesterId: string | null;
    reducer: MapReduceReducer;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    pendingTasks: number;
    results: MapReduceResultEntry[];
    reducedValue: unknown;
    message: string;
};

function decodeMaybeBase64ToString(raw: string): string {
    const trimmed = raw.trim();
    let normalized = trimmed;
    let forced = false;
    if (normalized.startsWith("base64:")) {
        normalized = normalized.slice(7);
        forced = true;
    } else if (normalized.startsWith("b64:")) {
        normalized = normalized.slice(4);
        forced = true;
    }

    const base64Pattern = /^[A-Za-z0-9+/=_-]+$/;
    if (
        !forced &&
        (!base64Pattern.test(normalized) || (normalized.length % 4 !== 0 && !normalized.includes("=")))
    ) {
        return trimmed;
    }

    const needsPadding = normalized.length % 4;
    const padded = needsPadding ? normalized + "=".repeat(4 - needsPadding) : normalized;
    const encoding: BufferEncoding = normalized.includes("-") || normalized.includes("_") ? "base64url" : "base64";

    try {
        const decoded = Buffer.from(padded, encoding).toString("utf8");
        if (!forced) {
            const nonPrintable = decoded.replace(/[\x20-\x7E\r\n\t]/g, "");
            if (nonPrintable.length > 0) {
                return trimmed;
            }
        }
        if (!forced && decoded.trim().length === 0) {
            return trimmed;
        }
        return decoded;
    } catch (error) {
        // Not base64; return original string.
        return trimmed;
    }
}

function parseMaybeJson(value: string): unknown {
    const text = decodeMaybeBase64ToString(value);
    try {
        return JSON.parse(text);
    } catch (error) {
        return text;
    }
}

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
    private readonly commands = [
        "help",
        "storage",
        "put",
        "get",
        "delete",
        "keys",
        "expire",
        "ttl",
        "peers",
        "whoami",
        "benchmark",
        "broadcast",
        "audio",
        "mapreduce",
    ] as const;
    private state?: DurableObjectState;
    private pendingBenchmarks = new Map<string, PendingBenchmark>();
    private pendingMapReduces = new Map<string, PendingMapReduce>();

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
            this.handleBenchmarkDeparture(record.info.id);
            this.handleMapReduceDeparture(record.info.id);
        }
        console.log(`Remaining clients: ${this.clients.length}`);
    }

    private resolveBenchmark(requestId: string, message?: string) {
        const pending = this.pendingBenchmarks.get(requestId);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timeoutHandle);
        this.pendingBenchmarks.delete(requestId);
        const completedAt = Date.now();
        const summary: BenchmarkSummary = {
            command: "benchmark",
            requestId,
            requesterId: pending.requesterId,
            iterations: pending.iterations,
            timeoutMs: pending.timeoutMs,
            startedAt: new Date(pending.createdAt).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
            durationMs: completedAt - pending.createdAt,
            participants: pending.results.length + pending.expected.size,
            responded: pending.results.length,
            pending: [...pending.expected],
            results: [...pending.results],
            message:
                message ?? (pending.expected.size === 0 ? "Benchmark completed" : "Benchmark completed with missing responses"),
        };
        pending.resolve(summary);
    }

    private handleBenchmarkDeparture(clientId: string) {
        for (const pending of this.pendingBenchmarks.values()) {
            if (pending.expected.delete(clientId) && pending.expected.size === 0) {
                this.resolveBenchmark(pending.requestId);
            }
        }
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

    async uploadAudioBase64(filename: string, base64Data: string, contentTypeHint?: string) {
        if (!(this as any).env?.AUDIO_BUCKET) {
            throw new Error("AUDIO_BUCKET binding is not configured");
        }

        if (!filename || typeof filename !== "string") {
            throw new TypeError("filename must be a non-empty string");
        }

        if (!base64Data || typeof base64Data !== "string") {
            throw new TypeError("base64Data must be a non-empty string");
        }

        let bytes: Uint8Array;
        try {
            const binary = atob(base64Data);
            bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
                bytes[i] = binary.charCodeAt(i);
            }
        } catch (error) {
            throw new TypeError(`Failed to decode base64 data: ${error instanceof Error ? error.message : String(error)}`);
        }

        const contentType =
            contentTypeHint ??
            (filename.endsWith('.mp3')
                ? 'audio/mpeg'
                : filename.endsWith('.wav')
                ? 'audio/wav'
                : filename.endsWith('.ogg')
                ? 'audio/ogg'
                : 'application/octet-stream');

        await (this as any).env.AUDIO_BUCKET.put(filename, bytes, {
            httpMetadata: {
                contentType,
            },
        });

        console.log(`Uploaded ${filename} (${bytes.length} bytes) to R2`);

        return {
            filename,
            size: bytes.length,
            contentType,
        };
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
            case "benchmark": {
                const subcommand = parts[1]?.toLowerCase();
                if (subcommand === "report") {
                    if (parts.length < 4) {
                        return {
                            command: "benchmark-report",
                            error: "Usage: benchmark report <requestId> <durationMs> [details-json]",
                        };
                    }

                    const requestId = parts[2];
                    const durationMs = Number.parseFloat(parts[3]);
                    if (!Number.isFinite(durationMs) || durationMs < 0) {
                        return {
                            command: "benchmark-report",
                            requestId,
                            error: "durationMs must be a non-negative number",
                        };
                    }

                    const rawDetails = parts.slice(4).join(" ");
                    let details: unknown = undefined;
                    if (rawDetails) {
                        try {
                            details = JSON.parse(rawDetails);
                        } catch (error) {
                            details = rawDetails;
                        }
                    }

                    const pending = this.pendingBenchmarks.get(requestId);
                    if (!pending) {
                        return {
                            command: "benchmark-report",
                            requestId,
                            accepted: false,
                            error: "Unknown benchmark request",
                        };
                    }

                    const responderId = clientId ?? "unknown";
                    if (!pending.results.some((result) => result.clientId === responderId)) {
                        const opsPerSecond =
                            typeof details === "object" && details !== null && typeof (details as any).opsPerSec === "number"
                                ? (details as any).opsPerSec
                                : undefined;
                        const iterations =
                            typeof details === "object" && details !== null && typeof (details as any).iterations === "number"
                                ? (details as any).iterations
                                : pending.iterations;
                        pending.results.push({
                            clientId: responderId,
                            durationMs,
                            iterations,
                            opsPerSecond,
                            receivedAt: new Date().toISOString(),
                            details,
                        });
                    }

                    pending.expected.delete(responderId);
                    if (pending.expected.size === 0) {
                        this.resolveBenchmark(requestId);
                    }

                    return {
                        command: "benchmark-report",
                        requestId,
                        accepted: true,
                    };
                }

                const tokens = parts.slice(1).filter(Boolean);
                let iterations = 50000;
                let timeoutMs = 5000;

                for (const token of tokens) {
                    if (!token || token.includes("report")) {
                        continue;
                    }
                    const optionMatch = token.match(/^(\w+)=([\w.-]+)$/);
                    if (optionMatch) {
                        const [, rawKey, rawValue] = optionMatch;
                        const key = rawKey.toLowerCase();
                        if (key === "timeout" || key === "timeoutms") {
                            const parsed = Number.parseInt(rawValue, 10);
                            if (Number.isFinite(parsed) && parsed > 0) {
                                timeoutMs = parsed;
                            }
                        } else if (key === "iterations" || key === "loops") {
                            const parsed = Number.parseInt(rawValue, 10);
                            if (Number.isFinite(parsed) && parsed > 0) {
                                iterations = parsed;
                            }
                        }
                        continue;
                    }
                    if (/^\d+$/.test(token)) {
                        const parsed = Number.parseInt(token, 10);
                        if (parsed > 0) {
                            iterations = parsed;
                        }
                    }
                }

                const participants = [...this.clients];
                if (participants.length === 0) {
                    return {
                        command: "benchmark",
                        error: "No connected clients available for benchmarking",
                    };
                }

                const requestId = randomRequestId();
                const createdAt = Date.now();
                const expected = new Set(participants.map(({ info }) => info.id));

                const summaryPromise = new Promise<BenchmarkSummary>((resolve) => {
                    const timeoutHandle = setTimeout(() => {
                        this.resolveBenchmark(requestId, "Benchmark timed out before all nodes replied");
                    }, timeoutMs);
                    this.pendingBenchmarks.set(requestId, {
                        requestId,
                        requesterId: clientId ?? null,
                        createdAt,
                        iterations,
                        timeoutMs,
                        expected,
                        results: [],
                        resolve,
                        timeoutHandle,
                    });
                });

                const payload = {
                    type: "benchmark-request",
                    requestId,
                    requesterId: clientId ?? null,
                    iterations,
                    timeoutMs,
                    startedAt: new Date(createdAt).toISOString(),
                };

                await Promise.all(
                    participants.map(async ({ stub, info }) => {
                        try {
                            await stub.broadcast(payload);
                        } catch (error) {
                            console.error("Failed to dispatch benchmark request", error);
                            expected.delete(info.id);
                            this.removeClient(stub);
                        }
                    }),
                );

                if (expected.size === 0) {
                    this.resolveBenchmark(requestId, "Benchmark request could not reach any clients");
                }

                return await summaryPromise;
            }
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
            case "mapreduce":
                return await this.handleMapReduceCommand(parts.slice(1), clientId);
            default:
                return {
                    command: cmd,
                    error: `Unknown command: ${cmd}`,
                    available: this.listCommands(),
                };
        }
    }

    private async handleMapReduceCommand(tokens: string[], clientId?: string) {
        if (tokens.length === 0) {
            return {
                command: "mapreduce",
                error: "Usage: mapreduce <start|report|status|cancel> ...",
                examples: [
                    "mapreduce start tasks=<base64-json>",
                    "mapreduce report <requestId> <taskId> <base64-result>",
                    "mapreduce status <requestId>",
                ],
            };
        }

        const subcommand = tokens[0]?.toLowerCase();
        if (subcommand === "report") {
            return this.handleMapReduceReport(tokens.slice(1), clientId);
        }
        if (subcommand === "status") {
            return this.handleMapReduceStatus(tokens.slice(1));
        }
        if (subcommand === "cancel") {
            return this.handleMapReduceCancel(tokens.slice(1), clientId);
        }

        const startTokens = subcommand === "start" || subcommand === "run" ? tokens.slice(1) : tokens;
        return await this.startMapReduce(startTokens, clientId);
    }

    private parsePositiveInt(value: string | undefined, fallback: number) {
        if (!value) {
            return fallback;
        }
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    }

    private normalizeReducer(raw: string | undefined): MapReduceReducer {
        const value = (raw ?? "collect").toLowerCase();
        if (["sum", "add", "total"].includes(value)) {
            return "sum";
        }
        if (["avg", "average", "mean"].includes(value)) {
            return "average";
        }
        if (["concat", "join", "string"].includes(value)) {
            return "concat";
        }
        if (["count", "len", "length"].includes(value)) {
            return "count";
        }
        if (["merge", "object", "combine"].includes(value)) {
            return "merge";
        }
        return "collect";
    }

    private normalizeMapReduceTasks(source: unknown): MapReduceTaskDescriptor[] {
        if (!source) {
            return [];
        }

        const result: MapReduceTaskDescriptor[] = [];

        if (Array.isArray(source)) {
            source.forEach((entry, index) => {
                if (entry && typeof entry === "object" && !Array.isArray(entry)) {
                    const candidate = entry as Record<string, unknown>;
                    const taskId =
                        typeof candidate.taskId === "string"
                            ? candidate.taskId
                            : typeof candidate.id === "string"
                            ? candidate.id
                            : `task-${index + 1}`;
                    const { payload, value, data, taskId: _taskId, id: _id, metadata: rawMeta, ...rest } = candidate;
                    const payloadValue = payload ?? value ?? data ?? rest;
                    const metadata =
                        rawMeta && typeof rawMeta === "object"
                            ? (rawMeta as Record<string, unknown>)
                            : null;
                    result.push({
                        taskId,
                        payload: payloadValue,
                        metadata,
                    });
                } else {
                    result.push({
                        taskId: `task-${index + 1}`,
                        payload: entry,
                    });
                }
            });
            return result;
        }

        if (typeof source === "object") {
            const candidate = source as Record<string, unknown>;
            if (Array.isArray(candidate.tasks)) {
                return this.normalizeMapReduceTasks(candidate.tasks);
            }
            for (const [key, value] of Object.entries(candidate)) {
                if (key === "metadata" || key === "config") continue;
                result.push({ taskId: String(key), payload: value });
            }
            return result;
        }

        return [];
    }

    private async startMapReduce(tokens: string[], clientId?: string): Promise<MapReduceSummary | { command: string; error: string; }> {
        const participants = [...this.clients];
        if (participants.length === 0) {
            return {
                command: "mapreduce",
                error: "No connected clients available for map/reduce",
            };
        }

        let encodedTasks: string | undefined;
        const options = new Map<string, string>();

        for (const token of tokens) {
            if (!token) continue;
            const eqIndex = token.indexOf("=");
            if (eqIndex === -1) {
                if (!encodedTasks) {
                    encodedTasks = token;
                }
                continue;
            }
            const key = token.slice(0, eqIndex).toLowerCase();
            const value = token.slice(eqIndex + 1);
            if (["tasks", "data", "work"].includes(key)) {
                encodedTasks = value;
            } else {
                options.set(key, value);
            }
        }

        if (!encodedTasks) {
            return {
                command: "mapreduce",
                error: "No tasks supplied. Use tasks=<json-or-base64>",
            };
        }

        const parsedSource = parseMaybeJson(encodedTasks);
        const taskDescriptors = this.normalizeMapReduceTasks(parsedSource);
        if (taskDescriptors.length === 0) {
            return {
                command: "mapreduce",
                error: "No tasks could be parsed from the provided payload",
            };
        }

        const reducer = this.normalizeReducer(options.get("reducer") ?? options.get("reduce"));
        const timeoutMs = this.parsePositiveInt(options.get("timeout") ?? options.get("timeoutms"), 15_000);

        const requestId = randomRequestId();
        const createdAt = Date.now();

        let resolveSummary!: (summary: MapReduceSummary) => void;
        const summaryPromise = new Promise<MapReduceSummary>((resolve) => {
            resolveSummary = resolve;
        });

        const timeoutHandle = setTimeout(() => {
            this.resolveMapReduce(requestId, "MapReduce timed out before all tasks completed");
        }, timeoutMs);

        const pending: PendingMapReduce = {
            requestId,
            requesterId: clientId ?? null,
            createdAt,
            timeoutMs,
            reducer,
            tasks: taskDescriptors.map((descriptor) => ({
                ...descriptor,
                attempts: 0,
            })),
            resolve: resolveSummary,
            timeoutHandle,
            nextClientIndex: 0,
        };

        this.pendingMapReduces.set(requestId, pending);

        console.log(
            `Starting map/reduce request ${requestId} with ${pending.tasks.length} task(s) across ${participants.length} client(s)`,
        );

        for (const task of pending.tasks) {
            const dispatched = await this.dispatchMapReduceTask(pending, task);
            if (!dispatched) {
                task.error = "Failed to dispatch task to any client";
                task.completedAt = Date.now();
            }
        }

        this.checkMapReduceCompletion(requestId);

        return await summaryPromise;
    }

    private handleMapReduceReport(tokens: string[], clientId?: string) {
        if (tokens.length < 2) {
            return {
                command: "mapreduce-report",
                error: "Usage: mapreduce report <requestId> <taskId> [<result>|result=<value>] [error=<message>] [metadata=<json>]",
            };
        }

        const [requestId, taskId] = tokens;
        const pending = this.pendingMapReduces.get(requestId);
        if (!pending) {
            return {
                command: "mapreduce-report",
                requestId,
                taskId,
                accepted: false,
                error: "Unknown mapreduce request",
            };
        }

        let encodedResult: string | undefined;
        let errorMessage: string | undefined;
        let metadata: unknown = undefined;

        for (let i = 2; i < tokens.length; i += 1) {
            const token = tokens[i];
            if (!token) continue;
            const eqIndex = token.indexOf("=");
            if (eqIndex === -1 && encodedResult === undefined) {
                encodedResult = token;
                continue;
            }
            if (eqIndex !== -1) {
                const key = token.slice(0, eqIndex).toLowerCase();
                const value = token.slice(eqIndex + 1);
                if ((key === "result" || key === "value") && encodedResult === undefined) {
                    encodedResult = value;
                } else if (key === "error") {
                    errorMessage = decodeMaybeBase64ToString(value);
                } else if (key === "metadata") {
                    metadata = parseMaybeJson(value);
                }
            }
        }

        if (!encodedResult && !errorMessage) {
            encodedResult = "null";
        }

        const task = pending.tasks.find((item) => item.taskId === taskId);
        if (!task) {
            return {
                command: "mapreduce-report",
                requestId,
                taskId,
                accepted: false,
                error: "Unknown task identifier",
            };
        }

        if (task.completedAt) {
            return {
                command: "mapreduce-report",
                requestId,
                taskId,
                accepted: false,
                error: "Task already reported",
            };
        }

        if (clientId && task.assignedTo && task.assignedTo !== clientId) {
            console.warn(
                `MapReduce task ${taskId} for request ${requestId} reported by unexpected client ${clientId}; expected ${task.assignedTo}`,
            );
        }

        const completedAt = Date.now();
        task.completedAt = completedAt;
        if (errorMessage) {
            task.error = errorMessage;
            task.result = undefined;
        } else if (encodedResult !== undefined) {
            const parsed = parseMaybeJson(encodedResult);
            task.result = parsed;
        }
        if (metadata !== undefined) {
            task.resultMetadata = metadata;
        }

        const acceptedResponse = {
            command: "mapreduce-report",
            requestId,
            taskId,
            accepted: true,
        };

        this.checkMapReduceCompletion(requestId);

        return acceptedResponse;
    }

    private handleMapReduceStatus(tokens: string[]) {
        if (tokens.length < 1) {
            return {
                command: "mapreduce-status",
                error: "Usage: mapreduce status <requestId>",
            };
        }

        const [requestId] = tokens;
        const pending = this.pendingMapReduces.get(requestId);
        if (!pending) {
            return {
                command: "mapreduce-status",
                requestId,
                active: false,
            };
        }

        const snapshot = {
            command: "mapreduce-status",
            requestId,
            active: true,
            reducer: pending.reducer,
            requesterId: pending.requesterId,
            startedAt: new Date(pending.createdAt).toISOString(),
            timeoutAt: new Date(pending.createdAt + pending.timeoutMs).toISOString(),
            totalTasks: pending.tasks.length,
            completedTasks: pending.tasks.filter((task) => task.completedAt).length,
            failedTasks: pending.tasks.filter((task) => task.error).length,
            results: pending.tasks.map<MapReduceResultEntry>((task) => ({
                taskId: task.taskId,
                assignedTo: task.assignedTo,
                attempts: task.attempts,
                durationMs:
                    task.completedAt && task.assignedAt ? task.completedAt - task.assignedAt : undefined,
                result: task.error ? undefined : task.result,
                error: task.error,
                metadata: task.resultMetadata,
            })),
        };

        return snapshot;
    }

    private handleMapReduceCancel(tokens: string[], clientId?: string) {
        if (tokens.length < 1) {
            return {
                command: "mapreduce-cancel",
                error: "Usage: mapreduce cancel <requestId>",
            };
        }

        const [requestId] = tokens;
        const pending = this.pendingMapReduces.get(requestId);
        if (!pending) {
            return {
                command: "mapreduce-cancel",
                requestId,
                cancelled: false,
                error: "Unknown mapreduce request",
            };
        }

        const actor = clientId ? ` by ${clientId}` : "";
        this.resolveMapReduce(requestId, `MapReduce cancelled${actor}`);

        return {
            command: "mapreduce-cancel",
            requestId,
            cancelled: true,
        };
    }

    private async dispatchMapReduceTask(pending: PendingMapReduce, task: MapReduceTaskState): Promise<boolean> {
        const participants = [...this.clients];
        if (participants.length === 0) {
            return false;
        }

        const startIndex = pending.nextClientIndex % participants.length;
        for (let offset = 0; offset < participants.length; offset += 1) {
            const candidate = participants[(startIndex + offset) % participants.length];
            try {
                await candidate.stub.broadcast({
                    type: "mapreduce-task",
                    requestId: pending.requestId,
                    taskId: task.taskId,
                    payload: task.payload,
                    metadata: task.metadata ?? null,
                    reducer: pending.reducer,
                    totalTasks: pending.tasks.length,
                    timeoutMs: pending.timeoutMs,
                    attempts: task.attempts + 1,
                });
                task.assignedTo = candidate.info.id;
                task.assignedAt = Date.now();
                task.attempts += 1;

                const clientCount = this.clients.length;
                if (clientCount === 0) {
                    pending.nextClientIndex = 0;
                } else {
                    const indexInClients = this.clients.findIndex((entry) => entry.info.id === candidate.info.id);
                    pending.nextClientIndex = indexInClients === -1 ? 0 : (indexInClients + 1) % clientCount;
                }

                return true;
            } catch (error) {
                console.error(
                    `Failed to dispatch mapreduce task ${task.taskId} to client ${candidate.info.id}: ${error instanceof Error ? error.message : String(error)}`,
                );
                this.removeClient(candidate.stub);
            }
        }

        return false;
    }

    private handleMapReduceDeparture(clientId: string) {
        for (const pending of this.pendingMapReduces.values()) {
            for (const task of pending.tasks) {
                if (!task.completedAt && task.assignedTo === clientId) {
                    task.assignedTo = undefined;
                    task.assignedAt = undefined;
                    setTimeout(() => {
                        if (!this.pendingMapReduces.has(pending.requestId)) {
                            return;
                        }
                        void this.dispatchMapReduceTask(pending, task).then((dispatched) => {
                            if (!dispatched) {
                                task.error = task.error ?? "Failed to reassign after client departure";
                                task.completedAt = Date.now();
                                this.checkMapReduceCompletion(pending.requestId);
                            }
                        });
                    }, 0);
                }
            }
        }
    }

    private checkMapReduceCompletion(requestId: string) {
        const pending = this.pendingMapReduces.get(requestId);
        if (!pending) {
            return;
        }

        const allDone = pending.tasks.every((task) => task.completedAt);
        if (allDone) {
            this.resolveMapReduce(requestId);
        }
    }

    private resolveMapReduce(requestId: string, message?: string) {
        const pending = this.pendingMapReduces.get(requestId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeoutHandle);
        this.pendingMapReduces.delete(requestId);

        const completedAt = Date.now();
        const unfinished = pending.tasks.filter((task) => !task.completedAt);
        for (const task of unfinished) {
            task.completedAt = completedAt;
            task.error = task.error ?? "No response received";
        }

        const results: MapReduceResultEntry[] = pending.tasks.map((task) => ({
            taskId: task.taskId,
            assignedTo: task.assignedTo,
            attempts: task.attempts,
            durationMs: task.completedAt && task.assignedAt ? task.completedAt - task.assignedAt : undefined,
            result: task.error ? undefined : task.result,
            error: task.error,
            metadata: task.resultMetadata,
        }));

        const successfulResults = pending.tasks
            .filter((task) => task.completedAt && !task.error)
            .map((task) => task.result);

        const reducedValue = this.reduceMapReduceResults(pending.reducer, successfulResults);

        const totalTasks = pending.tasks.length;
        const completedTasks = pending.tasks.filter((task) => task.completedAt).length;
        const failedTasks = pending.tasks.filter((task) => task.error).length;
        const pendingTasks = unfinished.length;

        const summary: MapReduceSummary = {
            command: "mapreduce",
            requestId,
            requesterId: pending.requesterId,
            reducer: pending.reducer,
            startedAt: new Date(pending.createdAt).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
            durationMs: completedAt - pending.createdAt,
            totalTasks,
            completedTasks,
            failedTasks,
            pendingTasks,
            results,
            reducedValue,
            message:
                message ??
                (failedTasks === 0 && pendingTasks === 0
                    ? "MapReduce completed successfully"
                    : failedTasks > 0
                    ? "MapReduce completed with errors"
                    : "MapReduce completed with pending tasks"),
        };

        pending.resolve(summary);
    }

    private reduceMapReduceResults(reducer: MapReduceReducer, results: unknown[]): unknown {
        switch (reducer) {
            case "sum": {
                const numbers = results
                    .map((value) => {
                        if (typeof value === "number") return value;
                        if (typeof value === "string") {
                            const parsed = Number.parseFloat(value);
                            return Number.isFinite(parsed) ? parsed : null;
                        }
                        return null;
                    })
                    .filter((value): value is number => value !== null);
                return numbers.reduce((total, value) => total + value, 0);
            }
            case "average": {
                const numbers = results
                    .map((value) => {
                        if (typeof value === "number") return value;
                        if (typeof value === "string") {
                            const parsed = Number.parseFloat(value);
                            return Number.isFinite(parsed) ? parsed : null;
                        }
                        return null;
                    })
                    .filter((value): value is number => value !== null);
                if (numbers.length === 0) {
                    return 0;
                }
                const total = numbers.reduce((sum, value) => sum + value, 0);
                return total / numbers.length;
            }
            case "concat": {
                return results.map((value) => (value === undefined || value === null ? "" : String(value))).join("");
            }
            case "count":
                return results.length;
            case "merge": {
                const merged: Record<string, unknown> = {};
                for (const value of results) {
                    if (value && typeof value === "object" && !Array.isArray(value)) {
                        Object.assign(merged, value as Record<string, unknown>);
                    }
                }
                return merged;
            }
            case "collect":
            default:
                return results;
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
                    return new Response('Audio file not found', {
                        status: 404,
                        headers: {
                            ...CORS_HEADERS,
                            'Content-Type': 'text/plain',
                        },
                    });
                }
                
                // Return the audio file with appropriate headers
                return new Response(object.body, {
                    headers: {
                        ...CORS_HEADERS,
                        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
                        'Content-Length': object.size.toString(),
                        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
                    },
                });
            } catch (error) {
                console.error('Error serving audio file:', error);
                return new Response('Internal server error', {
                    status: 500,
                    headers: {
                        ...CORS_HEADERS,
                        'Content-Type': 'text/plain',
                    },
                });
            }
        }

        if (url.pathname === '/upload') {
            if (request.method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: {
                        ...CORS_HEADERS,
                    },
                });
            }

            if (request.method !== 'POST') {
                return new Response(JSON.stringify({ error: 'Method not allowed' }), {
                    status: 405,
                    headers: {
                        ...CORS_HEADERS,
                        'Content-Type': 'application/json',
                    },
                });
            }

            let payload: { filename?: string; base64?: string; contentType?: string };
            try {
                payload = await request.json();
            } catch (error) {
                return new Response(
                    JSON.stringify({ error: 'Invalid JSON body', details: error instanceof Error ? error.message : String(error) }),
                    {
                        status: 400,
                        headers: {
                            ...CORS_HEADERS,
                            'Content-Type': 'application/json',
                        },
                    },
                );
            }

            const { filename, base64, contentType } = payload;

            if (!filename || typeof filename !== 'string') {
                return new Response(JSON.stringify({ error: 'filename is required' }), {
                    status: 400,
                    headers: {
                        ...CORS_HEADERS,
                        'Content-Type': 'application/json',
                    },
                });
            }

            if (!base64 || typeof base64 !== 'string') {
                return new Response(JSON.stringify({ error: 'base64 is required' }), {
                    status: 400,
                    headers: {
                        ...CORS_HEADERS,
                        'Content-Type': 'application/json',
                    },
                });
            }

            try {
                const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
                const inferredContentType =
                    contentType ||
                    (filename.endsWith('.mp3')
                        ? 'audio/mpeg'
                        : filename.endsWith('.wav')
                        ? 'audio/wav'
                        : filename.endsWith('.ogg')
                        ? 'audio/ogg'
                        : filename.endsWith('.flac')
                        ? 'audio/flac'
                        : filename.endsWith('.m4a')
                        ? 'audio/mp4'
                        : 'application/octet-stream');

                await env.AUDIO_BUCKET.put(filename, bytes, {
                    httpMetadata: {
                        contentType: inferredContentType,
                    },
                });

                return new Response(
                    JSON.stringify({ filename, size: bytes.length, contentType: inferredContentType }),
                    {
                        status: 200,
                        headers: {
                            ...CORS_HEADERS,
                            'Content-Type': 'application/json',
                        },
                    },
                );
            } catch (error) {
                return new Response(
                    JSON.stringify({ error: 'Upload failed', details: error instanceof Error ? error.message : String(error) }),
                    {
                        status: 500,
                        headers: {
                            ...CORS_HEADERS,
                            'Content-Type': 'application/json',
                        },
                    },
                );
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
