// Requests to the local League APIs (the client's lockfile API and the game's
// own endpoints). Part of the recorder: it reads the queue of the game being
// played. Moved from scripts/dataset/replay.ts, which re-exports it.
import https from "node:https";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * One request to a local League API (the client's, the Riot Client's or the
 * replay's), settled whatever the other side does: answered, refused, silent
 * past the timeout, or closed halfway through its answer. `send` is
 * https.request; the tests pass http.request to do without a certificate.
 */
export function httpsJson<T>(
  port: number,
  apiPath: string,
  options: {
    method?: string;
    auth?: string;
    body?: unknown;
    // A frozen game or client can accept a request and never answer.
    timeoutMs?: number;
  } = {},
  send: typeof https.request = https.request,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);

    const request = send(
      {
        hostname: "127.0.0.1",
        port,
        path: apiPath,
        method: options.method ?? "GET",
        rejectUnauthorized: false,
        auth: options.auth,
        headers:
          body === undefined
            ? undefined
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (raw += chunk));
        // A game that closes or is killed while it answers ends the
        // connection without "end", and the request has no error left to
        // give: without these the caller waited forever (on Node 24), and the
        // queue's watchdog with it.
        const cut = () =>
          reject(
            new Error(
              `Local League API ${options.method ?? "GET"} ${apiPath} closed the connection before the end of its answer`,
            ),
          );
        response.on("error", cut);
        response.on("close", () => {
          if (!response.complete) cut();
        });
        response.on("end", () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            reject(
              new Error(
                `Local League API ${options.method ?? "GET"} ${apiPath} returned ${status}: ${raw}`,
              ),
            );
            return;
          }

          if (!raw) {
            resolve(undefined as T);
            return;
          }

          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            resolve(raw as T);
          }
        });
      },
    );

    request.setTimeout(options.timeoutMs ?? 20_000, () =>
      request.destroy(
        new Error(
          `Local League API ${options.method ?? "GET"} ${apiPath} did not answer in time`,
        ),
      ),
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export async function lcuConnection() {
  const installDir =
    process.env.LEAGUE_INSTALL_DIR ?? "C:\\Riot Games\\League of Legends";
  const lockfilePath = path.join(installDir, "lockfile");

  let lockfile: string;
  try {
    lockfile = await readFile(lockfilePath, "utf8");
  } catch {
    throw new Error(
      `League Client lockfile not found at ${lockfilePath}. Start the League client or set LEAGUE_INSTALL_DIR.`,
    );
  }

  const [processName, pid, port, password, protocol] = lockfile.trim().split(":");
  if (!port || !password) {
    throw new Error(`Invalid League lockfile: ${lockfilePath}`);
  }

  return {
    processName,
    pid: Number(pid),
    port: Number(port),
    protocol,
    auth: `riot:${password}`,
  };
}

export async function lcuRequest<T>(
  apiPath: string,
  method = "GET",
  body?: unknown,
) {
  const lcu = await lcuConnection();
  return httpsJson<T>(lcu.port, apiPath, {
    method,
    auth: lcu.auth,
    body,
  });
}
