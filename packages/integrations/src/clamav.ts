import { Socket } from "node:net";
import type { DocumentScanner, ScanVerdict } from "@locum/core";

/**
 * §12.1 — the real malware scanner, speaking clamd's INSTREAM protocol.
 *
 * `StubDocumentScanner` detects EICAR and nothing else, and it is the last
 * reason `assertProductionReady` refuses to boot. §12.1 requires uploads to be
 * "scanned for malware before storage", and `uploadDocument` already honours
 * that ordering: detect type, scan, and only then write. This supplies the
 * middle step for real.
 *
 * ## Fail closed, and the interface makes that the only option
 *
 * `ScanVerdict` is `{clean: true}` or `{clean: false, detail}`. There is no
 * third value for "the scanner did not answer" — so every failure here THROWS.
 *
 * That is the whole point. A scanner that returns `clean` when it is
 * unreachable turns an outage into a silent policy change: uploads keep
 * working, the admin queue keeps showing documents as scanned, and nothing
 * anywhere records that a day's worth of files went in unexamined. An upload
 * that fails loudly is an inconvenience; an upload that succeeds without
 * scanning is the failure §12.1 exists to prevent.
 *
 * `uploadDocument` awaits this before `storage.put`, so a throw means nothing
 * reaches the bucket.
 *
 * ## INSTREAM rather than SCAN
 *
 * The file-path commands (`SCAN`, `CONTSCAN`) require clamd to read the same
 * filesystem as the caller. On Fargate that means a shared volume and a
 * sidecar with read access to the upload — and the bytes are ID documents, so
 * every additional place they are written is a place they can be left behind.
 * INSTREAM sends them over a socket and clamd never writes them down.
 */

export interface ClamavConfig {
  readonly host: string;
  readonly port: number;
  /**
   * Must not exceed clamd's own `StreamMaxLength`. Exceeding it makes clamd
   * reply with an error and close mid-stream, which this reports as a failure
   * rather than as a clean file — but a limit that disagrees with the daemon's
   * turns every large upload into an incident.
   */
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export class ClamavError extends Error {
  /** Whether the CONDITION is transient. Never an instruction to store anyway. */
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = "ClamavError";
    this.retryable = retryable;
  }
}

/** 25 MiB, matching the StreamMaxLength this is deployed against. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/*
 * clamd's INSTREAM framing: the command, then length-prefixed chunks, then a
 * zero-length chunk to end the stream. Lengths are 4-byte big-endian.
 *
 * 64 KiB chunks because clamd reads a chunk at a time; one enormous write is
 * accepted but buffers the entire file in the daemon before scanning starts.
 */
const CHUNK_BYTES = 64 * 1024;

export class ClamavDocumentScanner implements DocumentScanner {
  private readonly config: ClamavConfig;

  constructor(config: ClamavConfig) {
    this.config = config;
  }

  async scan(body: Buffer): Promise<ScanVerdict> {
    const maxBytes = this.config.maxBytes ?? DEFAULT_MAX_BYTES;

    if (body.byteLength > maxBytes) {
      /*
       * Rejected here rather than discovered mid-stream. clamd's own response
       * to an oversized stream is an error and an abrupt close, which is
       * indistinguishable from the daemon dying — and the two want very
       * different responses from whoever is on call.
       */
      throw new ClamavError(
        `Document is ${body.byteLength} bytes, over the ${maxBytes}-byte scan limit`,
        false,
      );
    }

    const response = await this.instream(body, maxBytes);

    /*
     * clamd answers one of three ways, and only ONE of them means clean.
     * Anything unrecognised is treated as a failure, not as a pass — a parser
     * that falls through to `clean` is the same silent policy change as a
     * scanner that is down.
     */
    if (response.endsWith("OK") && !response.includes("FOUND")) {
      return { clean: true };
    }

    if (response.endsWith("FOUND")) {
      // "stream: Win.Test.EICAR_HDB-1 FOUND" → the signature name, which is
      // what an admin needs to tell a false positive from a real detection.
      const signature = response.replace(/^stream:\s*/, "").replace(/\s*FOUND$/, "");
      return { clean: false, detail: signature };
    }

    throw new ClamavError(`Unexpected clamd response: ${response}`);
  }

  /**
   * Sends the body and returns clamd's single-line reply.
   *
   * Written directly on a socket rather than through a client library: this is
   * the entire protocol, and a dependency here would be a third party sitting
   * between an identity document and the only thing checking it.
   */
  private instream(body: Buffer, maxBytes: number): Promise<string> {
    const timeoutMs = this.config.timeoutMs ?? 30_000;

    return new Promise<string>((resolve, reject) => {
      const socket = new Socket();
      let received = "";
      let settled = false;

      const finish = (error: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };

      socket.setTimeout(timeoutMs, () => {
        /*
         * A timeout is NOT a clean result. Large files legitimately take time
         * to scan, so this is deliberately generous — but when it expires the
         * answer is "unknown", and unknown fails the upload.
         */
        finish(new ClamavError(`clamd did not answer within ${timeoutMs}ms`));
      });

      socket.on("error", (error) => {
        finish(new ClamavError(`clamd connection failed: ${error.message}`));
      });

      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        // Replies are NUL-terminated in the `z` command variant.
        if (received.includes("\0")) {
          finish(null, received.replace(/\0/g, "").trim());
        }
      });

      socket.on("close", () => {
        /*
         * Closed with no complete reply. clamd does this when a stream exceeds
         * StreamMaxLength, and it is exactly the case that must not be read as
         * success — the size check above exists to make this rare, and this
         * exists because the daemon's limit is the one that actually counts.
         */
        finish(
          new ClamavError(
            `clamd closed the connection without a verdict (stream limit is ${maxBytes} bytes here; ` +
              "check the daemon's StreamMaxLength)",
          ),
        );
      });

      socket.connect(this.config.port, this.config.host, () => {
        socket.write("zINSTREAM\0");

        for (let offset = 0; offset < body.byteLength; offset += CHUNK_BYTES) {
          const chunk = body.subarray(offset, offset + CHUNK_BYTES);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(chunk.byteLength, 0);
          socket.write(header);
          socket.write(chunk);
        }

        // Zero-length chunk: end of stream.
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      });
    });
  }

  /**
   * Liveness check for §12.2's ops dashboard.
   *
   * Worth exposing separately because a scanner that is down does not announce
   * itself — it shows up as uploads failing, which reads as a client problem.
   */
  async ping(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = new Socket();
      let received = "";
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(this.config.timeoutMs ?? 5_000, () => done(false));
      socket.on("error", () => done(false));
      socket.on("close", () => done(received.includes("PONG")));
      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        if (received.includes("PONG")) done(true);
      });
      socket.connect(this.config.port, this.config.host, () => socket.write("zPING\0"));
    });
  }
}
