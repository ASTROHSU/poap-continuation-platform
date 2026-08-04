import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

await copyFile(resolve("vercel.demo.json"), resolve("dist/client/vercel.json"));
console.log("Prepared dist/client as a Vercel SPA demonstration build.");
