import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nextServerStub = new URL("./next-server-stub.mjs", import.meta.url).href;
const dbMock = new URL("./db-mock.mjs", import.meta.url).href;
const sofiRuntimeStub = new URL("./sofi-runtime-stub.mjs", import.meta.url).href;

function localFile(specifier, context) {
  let file = null;
  if (specifier.startsWith("@/")) {
    file = path.join(root, specifier.slice(2));
  } else if (
    context?.parentURL &&
    (specifier.startsWith("./") || specifier.startsWith("../"))
  ) {
    file = fileURLToPath(new URL(specifier, context.parentURL));
  } else {
    return null;
  }

  if (path.extname(file)) return file;
  for (const extension of [".ts", ".tsx", ".js", ".mjs", ".json"]) {
    if (fs.existsSync(`${file}${extension}`)) return `${file}${extension}`;
  }
  return file;
}

function isDatabaseModule(file) {
  return /[/\\]lib[/\\]db(?:\.ts)?$/i.test(file);
}

function isSofiRuntime(file) {
  return /[/\\]lib[/\\]sofi-(?:pipeline|generate)\.ts$/i.test(file);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server" || specifier === "next/server.js") {
    return { url: nextServerStub, shortCircuit: true };
  }

  const file = localFile(specifier, context);
  if (file && isDatabaseModule(file)) {
    return { url: dbMock, shortCircuit: true };
  }
  if (file && isSofiRuntime(file)) {
    return { url: sofiRuntimeStub, shortCircuit: true };
  }
  if (file && file.endsWith(".json")) {
    return { url: pathToFileURL(file).href, shortCircuit: true };
  }
  if (file && (specifier.startsWith("@/") || !path.extname(specifier))) {
    return nextResolve(pathToFileURL(file).href, context);
  }

  const resolved = await nextResolve(specifier, context);
  if (!resolved.url.startsWith("file:")) return resolved;
  const resolvedFile = fileURLToPath(resolved.url);
  if (isDatabaseModule(resolvedFile)) {
    return { url: dbMock, shortCircuit: true };
  }
  if (resolved.url.endsWith(".json")) {
    return { url: resolved.url, shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".json")) {
    const source = fs.readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      source: `export default ${source};\n`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}
