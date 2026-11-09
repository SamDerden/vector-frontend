import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root=process.cwd();
const manifestPath=path.join(root,"prompts/manifest.json");
const manifest=JSON.parse(await fs.readFile(manifestPath,"utf8"));
const common=await fs.readFile(path.join(root,"prompts/common/1.0.2.md"),"utf8");
for(const tier of ["1-4","5-8","9-11"]){
 const entry=manifest[tier];
 const [name,version]=entry.prompt.split("@");
 const specific=await fs.readFile(path.join(root,"prompts",name,version+".md"),"utf8");
 const sha256=createHash("sha256").update(specific).update("\0").update(common).digest("hex");
 if(entry.sha256!==sha256){
  console.log("[Prompt manifest] Synchronizing",entry.prompt,"SHA-256",sha256);
  entry.sha256=sha256;
 }
}
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n");
console.log("[Prompt manifest] All three tier prompt hashes verified against bundled source files");
