import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

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

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return nextResolve("next/server.js", context);
  }
  const file = localFile(specifier, context);
  if (file && (specifier.startsWith("@/") || !path.extname(specifier))) {
    return nextResolve(pathToFileURL(file).href, context);
  }
  return nextResolve(specifier, context);
}
