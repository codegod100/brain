import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";

type ClientCallback = {
    broadcast(message: string): Promise<void> | void;
};

type Env = {
    RPC_HUB: DurableObjectNamespace;
};

class HubApi extends RpcTarget {
    private clients: RpcStub<ClientCallback>[] = [];

    addClient(stub: RpcStub<ClientCallback>) {
        const dup = stub.dup();
        dup.onRpcBroken((error) => {
            console.log("Client stub broken", error);
            this.removeClient(dup);
        });
        this.clients.push(dup);
        console.log(`Registered client; total clients: ${this.clients.length}`);
    }

    removeClient(stub: RpcStub<ClientCallback>) {
        const index = this.clients.indexOf(stub);
        if (index !== -1) {
            const [removed] = this.clients.splice(index, 1);
            try {
                removed[Symbol.dispose]();
            } catch (error) {
                console.warn("Failed to dispose client stub", error);
            }
        }
        console.log(`Remaining clients: ${this.clients.length}`);
    }

    async broadcast(message: string) {
        console.log(`Broadcasting to ${this.clients.length} client(s)`);
        await Promise.all(
            this.clients.map(async (client) => {
                try {
                    await client.broadcast(message);
                } catch (error) {
                    console.error("Client broadcast failed", error);
                    if (
                        error instanceof Error &&
                        (error.message.includes("stub after it has been disposed") ||
                            error.message.includes("Cannot perform I/O on behalf of a different request"))
                    ) {
                        this.removeClient(client);
                    }
                }
            }),
        );
        return this.clients.length;
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

    constructor(private readonly state: DurableObjectState) {}

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
}
