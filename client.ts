import { RpcTarget,newWebSocketRpcSession } from "capnweb";
class Client extends RpcTarget {
  broadcast(message) {
     console.log(`Incoming message! ${message}`)
  }
}

let api = newWebSocketRpcSession("ws://localhost:8787");
await api.addClient(new Client())
const res = await api.broadcast("yolo")
// console.log(res)