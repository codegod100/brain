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
};

class HubApi extends RpcTarget {
    private clients: ClientRecord[] = [];
    private readonly commands = ["files", "help"] as const;
    private readonly files = [...PROJECT_FILES];

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

    async runCommand(command: string) {
        const normalized = command.trim().toLowerCase();
        switch (normalized) {
            case "files":
                return {
                    command: "files",
                    data: [...this.files],
                };
            case "help":
                return {
                    command: "help",
                    data: this.listCommands(),
                };
            default:
                return {
                    command,
                    error: `Unknown command: ${command}`,
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

export default {
    async fetch(request: Request, env: Env) {
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
            const id = env.RPC_HUB.idFromName("global");
            const stub = env.RPC_HUB.get(id);
            return stub.fetch(request);
        }
        return new Response("Expected WebSocket upgrade", { status: 426 });
    },
};

export class RpcHub {
    private readonly api = new HubApi();
    private broadcastInterval?: ReturnType<typeof setInterval>;

    constructor(private readonly state: DurableObjectState) {
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

    private ensureTimer() {
        if (this.broadcastInterval) return;
        this.broadcastInterval = setInterval(() => {
            this.api
                .broadcast(new Date().toISOString())
                .catch((error) => console.error("Scheduled broadcast failed", error));
        }, 10_000);
    }
}
