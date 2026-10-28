import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const { key } = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
console.log([...hex].map((char) => String.fromCharCode(97 + parseInt(char, 16))).join(""));
