import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { createServer, request, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { createProviderPost, type ProviderPost } from "../../packages/ai/src/provider-http";

export const FIXTURE_PUBLIC_ADDRESS = "93.184.216.34";
export const FIXTURE_DUMMY_KEY = "sk-opspilot-fixture-only-not-a-real-key";
const tlsDirectory = new URL("../fixtures/provider-tls/", import.meta.url);
export const fixtureCa = await readFile(new URL("ca.pem", tlsDirectory));

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export type FixtureRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
  servername: string;
};
export type FixtureMode = "valid" | "malformed" | "forged" | "forged-only" | "invalid-shape" | "missing-content";
export type FixtureOptions = {
  certificate?: "server" | "wrong-host";
  mode?: FixtureMode;
  handler?: (request: FixtureRequest, response: ServerResponse) => void | Promise<void>;
};
export type FixturePostOptions = {
  resolve?: typeof lookup;
  trusted?: boolean;
  lookupAll?: boolean;
};
export type FixtureTransportObservation = {
  hostname: string;
  servername: string | undefined;
  family: number | undefined;
  agent: RequestOptions["agent"];
  rejectUnauthorized: boolean | undefined;
  autoSelectFamily: boolean | undefined;
  maxHeaderSize: number | undefined;
  pinnedAddresses: string[];
};

/** Extracts only the adapter's input JSON, not the system instructions. */
export function fixtureInput(body: unknown): JsonObject {
  const data = object(body);
  const messages = array(data.messages);
  let text = object(messages.find((message) => object(message).role === "user")).content;
  if (typeof text !== "string") {
    const contents = array(data.contents);
    const parts = array(object(contents[0]).parts);
    text = object(parts[0]).text;
  }
  if (typeof text !== "string") return {};
  const marker = text.indexOf("\n\nINPUT: ");
  let json = marker < 0 ? text : text.slice(marker + 9);
  const end = json.indexOf("\n\nEND UNTRUSTED INPUT");
  if (end >= 0) json = json.slice(0, end);
  try { return object(JSON.parse(json)); }
  catch { return {}; }
}

function diagnosis(body: unknown, mode: FixtureMode): string {
  if (mode === "malformed") return `not JSON: ${FIXTURE_DUMMY_KEY}`;
  if (mode === "invalid-shape") return JSON.stringify({ probable_cause: 42, confidence: "certain" });
  const evidence = array(fixtureInput(body).evidence);
  const firstId = object(evidence[0]).id;
  const ids = typeof firstId === "string" && mode !== "forged-only" ? [firstId] : [];
  if (mode === "forged" || mode === "forged-only") ids.push("forged-evidence-id-not-received");
  return JSON.stringify({
    probable_cause: "Synthetic fixture hypothesis; not a confirmed root cause.",
    confidence: "high",
    evidence_ids: ids,
    missing_evidence: ["Synthetic fixture requires human verification."],
    recommended_checks: ["Review measured evidence before confirming a resolution."],
  });
}

/** Test-only boundary: production validates a public address; only this wrapper maps it locally. */
export async function startProviderFixture(options: FixtureOptions = {}): Promise<{
  baseUrl: string;
  post: ProviderPost;
  createPost(options?: FixturePostOptions): ProviderPost;
  requests: FixtureRequest[];
  transports: FixtureTransportObservation[];
  setMode(mode: FixtureMode): void;
  close(): Promise<void>;
}> {
  const stem = options.certificate ?? "server";
  const [cert, key] = await Promise.all([
    readFile(new URL(`${stem}.pem`, tlsDirectory)),
    readFile(new URL(`${stem}-key.pem`, tlsDirectory)),
  ]);
  const requests: FixtureRequest[] = [];
  const transports: FixtureTransportObservation[] = [];
  const sockets = new Set<Socket>();
  let mode = options.mode ?? "valid";
  const server = createServer({ cert, key }, async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try { body = JSON.parse(rawBody); } catch { body = null; }
      const entry: FixtureRequest = {
        method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, rawBody,
        servername: (req.socket as TLSSocket).servername || "",
      };
      requests.push(entry);
      if (options.handler) { await options.handler(entry, res); return; }
      res.setHeader("Content-Type", "application/json");
      if (mode === "missing-content") { res.end(JSON.stringify({ unexpected: true })); return; }
      const text = diagnosis(body, mode);
      if (entry.path.endsWith("/chat/completions")) {
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      } else if (entry.path.endsWith("/messages")) {
        res.end(JSON.stringify({ content: [{ type: "text", text }] }));
      } else if (/\/models\/[^/]+:generateContent$/.test(entry.path)) {
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
      } else { res.statusCode = 404; res.end(JSON.stringify({ error: "Unknown synthetic operation" })); }
    } catch { res.destroy(); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("tlsClientError", () => {});
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => { server.off("error", listening.reject); listening.resolve(); });
  await listening.promise;
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `https://provider.example:${address.port}/v1`;
  const createPost = (postOptions: FixturePostOptions = {}): ProviderPost => {
    const resolve = postOptions.resolve ?? (async (hostname: string, dnsOptions: unknown) => {
      assert.equal(hostname, "provider.example");
      assert.deepEqual(dnsOptions, { all: true, verbatim: true });
      return [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }];
    }) as typeof lookup;
    const fixtureRequest = ((url: URL, nativeOptions: RequestOptions, callback: (response: IncomingMessage) => void) => {
      assert.equal(url.hostname, "provider.example");
      assert.equal(url.port, String(address.port));
      assert.equal(nativeOptions.servername, "provider.example");
      assert.equal(nativeOptions.rejectUnauthorized, true);
      assert.equal(nativeOptions.agent, false);
      assert.equal(nativeOptions.family, 4);
      assert.equal(nativeOptions.autoSelectFamily, false);
      assert.equal(nativeOptions.maxHeaderSize, 16 * 1024);
      assert.equal((nativeOptions.headers as Record<string, unknown>)["Accept-Encoding"], "identity");
      assert.equal(typeof nativeOptions.lookup, "function");
      const observation: FixtureTransportObservation = {
        hostname: url.hostname, servername: nativeOptions.servername, family: nativeOptions.family,
        agent: nativeOptions.agent, rejectUnauthorized: nativeOptions.rejectUnauthorized,
        autoSelectFamily: nativeOptions.autoSelectFamily, maxHeaderSize: nativeOptions.maxHeaderSize,
        pinnedAddresses: [],
      };
      transports.push(observation);
      const pinnedLookup = nativeOptions.lookup!;
      // Exercise the production callback's `all` shape too, regardless of native runtime preference.
      pinnedLookup(url.hostname, { all: true }, (error, answers) => {
        assert.ifError(error);
        assert.deepEqual(answers, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]);
      });
      const localLookup: NonNullable<RequestOptions["lookup"]> = (hostname, lookupOptions, done) => {
        assert.equal(hostname, url.hostname);
        const all = postOptions.lookupAll ?? (typeof lookupOptions === "object" && lookupOptions.all === true);
        if (all) {
          pinnedLookup(hostname, { all: true }, (error, answers) => {
            assert.ifError(error);
            assert.deepEqual(answers, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]);
            assert(Array.isArray(answers));
            observation.pinnedAddresses.push(...answers.map((answer) => answer.address));
            if (typeof lookupOptions === "object" && lookupOptions.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
            else done(null, "127.0.0.1", 4);
          });
        } else {
          pinnedLookup(hostname, { family: 4 }, (error, pinnedAddress, family) => {
            assert.ifError(error);
            assert.equal(pinnedAddress, FIXTURE_PUBLIC_ADDRESS);
            assert.equal(family, 4);
            assert(typeof pinnedAddress === "string");
            observation.pinnedAddresses.push(pinnedAddress);
            done(null, "127.0.0.1", 4);
          });
        }
      };
      return request(url, {
        ...nativeOptions, lookup: localLookup,
        ...(postOptions.trusted === false ? {} : { ca: fixtureCa }),
      }, callback);
    }) as typeof request;
    return createProviderPost({ resolve, request: fixtureRequest });
  };
  return {
    baseUrl, post: createPost(), createPost, requests, transports,
    setMode(next) { mode = next; },
    async close() {
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers<void>();
      server.close((error) => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    },
  };
}
