/** 临时工具: dump JSON 顶层字段 + 提取图片 base64 为 png。用法: node probe-json-dump.mjs <json文件> [输出png] */
import fs from "node:fs";

const file = process.argv[2];
const outPng = process.argv[3];
const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
console.log("KEYS:", Object.keys(j).join(", "));
for (const [k, v] of Object.entries(j)) {
  if (typeof v === "string" && v.length > 5000) {
    console.log(`[big-string] ${k} len=${v.length} head=${v.slice(0, 40)}`);
  }
}
if (outPng !== undefined) {
  let b64 = null;
  for (const [k, v] of Object.entries(j)) {
    if (typeof v === "string" && v.length > 10000 && /^[A-Za-z0-9+/=]+$/.test(v.slice(0, 100))) {
      b64 = v;
      console.log("PICK:", k);
      break;
    }
    if (v !== null && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v)) {
        if (typeof v2 === "string" && v2.length > 10000 && /^[A-Za-z0-9+/=]+$/.test(v2.slice(0, 100))) {
          b64 = v2;
          console.log("PICK:", `${k}.${k2}`);
          break;
        }
      }
      if (b64 !== null) break;
    }
  }
  if (b64 !== null) {
    fs.writeFileSync(outPng, Buffer.from(b64, "base64"));
    console.log("WROTE:", outPng, fs.statSync(outPng).size, "bytes");
  } else {
    console.log("NO IMAGE FOUND");
  }
}
