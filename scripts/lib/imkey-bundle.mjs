import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));

/** One browser file. imKey signs over WebUSB; this bundle never contains a private key. */
export async function imkeyBrowserBundle() {
  const result = await esbuild.build({
    absWorkingDir: resolve(HERE, "../.."),
    entryPoints: [resolve(HERE, "imkey-usb-entry.mjs")],
    bundle: true,
    format: "iife",
    globalName: "ImKeyUsb",
    platform: "browser",
    write: false,
    legalComments: "none",
    alias: {
      secp256k1: resolve(HERE, "secp256k1-browser.mjs"),
    },
    inject: [resolve(HERE, "buffer-global.mjs")],
    define: {
      global: "globalThis",
    },
    plugins: [{
      name: "imkey-missing-erc20",
      setup(build) {
        build.onResolve({ filter: /^\.\/erc20$/ }, (args) => {
          if (!args.importer.endsWith("erc20Utils.js")) return null;
          return { path: resolve(HERE, "imkey-erc20-stub.js") };
        });
      },
    }],
  });
  const js = result.outputFiles[0]?.text;
  if (!js || !js.includes("connectImKey") || !js.includes("signImKey")) {
    throw new Error("imKey 浏览器包不完整");
  }
  return js;
}
