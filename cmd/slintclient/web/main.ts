import { attachWasmBindings, clientApi } from "./client";

declare global {
  interface Window {
    clientApi: typeof clientApi;
  }
}

(async () => {
  try {
    const wasmPath = "../pkg/slintclient.js";
    const wasmModule: any = await import(/* @vite-ignore */ wasmPath);
    attachWasmBindings(wasmModule);
    window.clientApi = clientApi;
    if (typeof wasmModule.default === "function") {
      await wasmModule.default();
    }
    if (typeof wasmModule.run_app === "function") {
      wasmModule.run_app();
    } else {
      console.error("run_app not exported by wasm module");
    }
  } catch (error) {
    console.error("Failed to bootstrap Slint wasm module", error);
    // window.alert("Failed to start Slint client. Check console for details.");
  }
})();
