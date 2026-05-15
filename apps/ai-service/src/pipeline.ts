/** Placeholder audio pipeline: wire whisper.cpp / XTTS / RVC via subprocess env paths. */

import { env } from "./config.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function sttFromWavFile(wavPath: string): Promise<string> {
  if (!env.WHISPER_CLI_PATH) {
    return "(whisper not configured)";
  }
  return new Promise((resolve, reject) => {
    const p = spawn(env.WHISPER_CLI_PATH!, ["-f", wavPath, "-otxt"]);
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`whisper exit ${code}`)),
    );
  });
}

export async function synthesizeClonedVoice(
  text: string,
  profileDir: string,
): Promise<Buffer> {
  if (!env.XTTS_PATH) {
    return Buffer.from(text, "utf8");
  }
  const outWav = path.join(profileDir, `tts-${Date.now()}.wav`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(env.XTTS_PATH!, ["--text", text, "--out", outWav], { cwd: profileDir });
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`xtts ${code}`))));
  });
  let buf = await fs.promises.readFile(outWav);
  if (env.RVC_PATH) {
    const rvcOut = outWav.replace(".wav", "-rvc.wav");
    await new Promise<void>((resolve, reject) => {
      const p = spawn(env.RVC_PATH!, ["--in", outWav, "--out", rvcOut], { cwd: profileDir });
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`rvc ${code}`))));
    });
    buf = await fs.promises.readFile(rvcOut);
  }
  return buf;
}
