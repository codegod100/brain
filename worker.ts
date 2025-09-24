import { RpcStub, RpcTarget, newWorkersWebSocketRpcResponse } from "capnweb";

type ClientCallback = {
    broadcast(message: string): Promise<void> | void;
};

class Api extends RpcTarget {
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
            removed[Symbol.dispose]();
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
                        error.message.includes("stub after it has been disposed")
                    ) {
                        this.removeClient(client);
                    }
                }
            }),
        );
        return this.clients.length;
    }
}

const api = new Api();

export default {
    fetch(request: Request) {
        if (request.headers.get("Upgrade") === "websocket") {
            return newWorkersWebSocketRpcResponse(request, api);
        }
        return new Response("Expected WebSocket upgrade", { status: 426 });
    },
};
