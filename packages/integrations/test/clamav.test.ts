import { createServer, type Server } from "node:net";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EICAR_TEST_STRING } from "@locum/core";
import { ClamavDocumentScanner, ClamavError } from "../src/index";

/** Store-only zip so clamd's archive recursion can see EICAR inside a document. */
function zipStored(filename: string, content: Buffer): Buffer {
  const crc = crc32(content) >>> 0;
  const name = Buffer.from(filename, "utf8");
  const local = Buffer.alloc(30);
  local.write("PK\u0003\u0004", 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const file = Buffer.concat([local, name, content]);
  const central = Buffer.alloc(46);
  central.write("PK\u0001\u0002", 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const cd = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.write("PK\u0005\u0006", 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(file.length, 16);
  return Buffer.concat([file, cd, eocd]);
}

/**
 * GATE: security.malware_scanning
 *
 * Two halves, and the split is deliberate.
 *
 * The first half runs against a REAL clamd if one is reachable at
 * CLAMD_HOST/CLAMD_PORT. That is the only way to know the INSTREAM framing is
 * right — a length prefix off by four bytes produces a daemon that waits
 * forever, which no fake will reproduce because the fake was written from the
 * same misunderstanding as the code. It is skipped rather than failed when no
 * daemon is present, because §15 does not require one on every machine.
 *
 * The second half runs against a scripted socket server and covers what a real
 * clamd will not do on demand: die mid-stream, answer garbage, hang. Those are
 * the paths where returning `clean` would be catastrophic and where nothing
 * would ever notice, since the upload succeeds and the file looks scanned.
 *
 * The EICAR string is the industry-standard harmless test file every scanner
 * is required to detect. It is not malware and nothing here handles anything
 * that is.
 */

const CLAMD_HOST = process.env["CLAMD_HOST"] ?? "127.0.0.1";
const CLAMD_PORT = Number(process.env["CLAMD_PORT"] ?? 3310);

async function clamdAvailable(): Promise<boolean> {
  const scanner = new ClamavDocumentScanner({
    host: CLAMD_HOST,
    port: CLAMD_PORT,
    timeoutMs: 2_000,
  });
  return scanner.ping();
}

const haveClamd = await clamdAvailable();

describe.skipIf(!haveClamd)("GATE security.malware_scanning — against a real clamd", () => {
  const scanner = new ClamavDocumentScanner({ host: CLAMD_HOST, port: CLAMD_PORT });

  it("detects EICAR and names the signature", async () => {
    /*
     * The end-to-end proof: real daemon, real INSTREAM framing, real verdict.
     * The signature name is carried through because an admin triaging a
     * rejection needs to tell a false positive from a real detection, and
     * "rejected by a security scan" tells them nothing.
     */
    const verdict = await scanner.scan(Buffer.from(EICAR_TEST_STRING, "utf8"));

    expect(verdict.clean).toBe(false);
    if (verdict.clean) throw new Error("unreachable");
    expect(verdict.detail).toMatch(/EICAR/i);
  });

  it("passes an ordinary PDF", async () => {
    // The common case has to be quiet, or the scanner is just an outage.
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(4096, 0x20),
      Buffer.from("\n%%EOF\n"),
    ]);
    expect(await scanner.scan(pdf)).toEqual({ clean: true });
  });

  it("scans a file large enough to span several chunks", async () => {
    /*
     * The body is sent in 64 KiB length-prefixed chunks. A framing bug shows
     * up only past the first chunk boundary — under it, one chunk and one
     * terminator happen to work no matter how the loop is written.
     */
    const large = Buffer.alloc(300 * 1024, 0x41);
    expect(await scanner.scan(large)).toEqual({ clean: true });
  });

  it("finds EICAR inside a zip (real upload shape)", async () => {
    /*
     * Bare EICAR is already covered above. A live upload is a document
     * container; clamd's archive recursion is what actually inspects ID
     * packs. Padding EICAR with raw bytes is not the EICAR test file and
     * CI's daemon correctly returns OK for that — which is not a scanner
     * bug, just the published signature.
     */
    const archive = zipStored("eicar.com", Buffer.from(EICAR_TEST_STRING, "utf8"));
    const verdict = await scanner.scan(archive);
    expect(verdict.clean).toBe(false);
  });

  it("answers PING", async () => {
    expect(await scanner.ping()).toBe(true);
  });
});

/**
 * The failure paths, against a scripted server.
 *
 * Every one of these must fail the upload. `ScanVerdict` has no "unknown"
 * value on purpose — see the header of clamav.ts — so the assertion is always
 * that it throws, never that it returns something.
 */
describe("GATE security.malware_scanning — fails closed", () => {
  let server: Server;
  let port = 0;
  let behaviour: "silence" | "garbage" | "close-early" | "ok" = "ok";

  beforeAll(async () => {
    server = createServer((socket) => {
      socket.on("data", () => {
        if (behaviour === "ok") {
          socket.end("stream: OK\0");
        } else if (behaviour === "garbage") {
          socket.end("something else entirely\0");
        } else if (behaviour === "close-early") {
          // What clamd does when a stream exceeds StreamMaxLength.
          socket.destroy();
        }
        // "silence": hold the connection open and never answer.
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function scanner(timeoutMs = 500) {
    return new ClamavDocumentScanner({ host: "127.0.0.1", port, timeoutMs });
  }

  it("throws rather than returning clean when the scanner never answers", async () => {
    /*
     * THE test in this file. A scanner that returns `clean` on timeout turns
     * an outage into a silent policy change: uploads keep working, the admin
     * queue keeps showing documents as scanned, and a day of files goes in
     * unexamined with nothing recording it.
     */
    behaviour = "silence";
    const error = await scanner()
      .scan(Buffer.from("hello"))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClamavError);
    expect((error as ClamavError).message).toMatch(/did not answer/);
  });

  it("throws when clamd closes mid-stream", async () => {
    // How the daemon reacts to a stream over StreamMaxLength. Reading that as
    // success would let the largest uploads skip scanning entirely.
    behaviour = "close-early";
    const error = await scanner()
      .scan(Buffer.from("hello"))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClamavError);
    expect((error as ClamavError).message).toMatch(/without a verdict/);
  });

  it("throws on a response it does not recognise", async () => {
    // A parser that falls through to `clean` on an unfamiliar reply is the
    // same silent failure as a scanner that is down.
    behaviour = "garbage";
    const error = await scanner()
      .scan(Buffer.from("hello"))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClamavError);
    expect((error as ClamavError).message).toMatch(/Unexpected clamd response/);
  });

  it("throws when nothing is listening at all", async () => {
    const unreachable = new ClamavDocumentScanner({
      host: "127.0.0.1",
      port: 1, // reserved; nothing binds it
      timeoutMs: 500,
    });
    const error = await unreachable.scan(Buffer.from("hello")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClamavError);
  });

  it("rejects an oversized document before opening a socket", async () => {
    /*
     * Rejected here rather than discovered mid-stream, because clamd's own
     * reaction is an abrupt close — indistinguishable from the daemon dying,
     * and the two want very different responses from whoever is on call.
     */
    behaviour = "ok";
    const small = new ClamavDocumentScanner({
      host: "127.0.0.1",
      port,
      maxBytes: 1024,
    });
    const error = await small.scan(Buffer.alloc(2048)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClamavError);
    expect((error as ClamavError).message).toMatch(/over the 1024-byte scan limit/);
    // Not worth retrying: the file will be the same size next time.
    expect((error as ClamavError).retryable).toBe(false);
  });

  it("reports a clean verdict when clamd says OK", async () => {
    // The control. Without it the tests above pass on a scanner that throws
    // unconditionally, which would fail closed and also never work.
    behaviour = "ok";
    expect(await scanner().scan(Buffer.from("hello"))).toEqual({ clean: true });
  });

  it("ping reports false when the scanner is down", async () => {
    const unreachable = new ClamavDocumentScanner({
      host: "127.0.0.1",
      port: 1,
      timeoutMs: 500,
    });
    expect(await unreachable.ping()).toBe(false);
  });
});
