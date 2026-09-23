import { createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";

export interface AskpassBroker {
  pipeName: string;
  dispose(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

export async function createAskpassBroker(password: string): Promise<AskpassBroker> {
  if (process.platform !== "win32") throw new Error("SSH 密码认证当前仅支持 Windows。");
  const pipeName = `teamai-askpass-${randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  let disposed = false;
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let request = "";
    socket.on("data", (chunk: string) => {
      request += chunk;
      if (!request.includes("\n")) return;
      const encodedPrompt = request.slice(0, request.indexOf("\n")).trim();
      let prompt = "";
      try { prompt = Buffer.from(encodedPrompt, "base64").toString("utf8"); } catch { /* treated as unknown */ }
      const allowed = /(password|passphrase|verification code)/i.test(prompt);
      socket.end(`${allowed && !disposed ? Buffer.from(password, "utf8").toString("base64") : ""}\n`);
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    pipeName,
    async dispose() {
      disposed = true;
      password = "";
      await closeServer(server);
    },
  };
}
