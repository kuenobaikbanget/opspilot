import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

export type ProviderErrorCode =
  | "invalid_endpoint" | "endpoint_not_public" | "dns_failed"
  | "provider_timeout" | "provider_response_too_large" | "provider_invalid_response"
  | "provider_network" | "provider_redirect" | "provider_http" | "provider_configuration";

const messages: Record<ProviderErrorCode, string> = {
  invalid_endpoint: "Invalid provider endpoint.",
  endpoint_not_public: "Provider endpoint must use public HTTPS.",
  dns_failed: "Provider DNS resolution failed.",
  provider_timeout: "Provider request timed out.",
  provider_response_too_large: "Provider response exceeded the size limit.",
  provider_invalid_response: "Provider returned an invalid response.",
  provider_network: "Provider connection failed.",
  provider_redirect: "Provider redirects are not allowed.",
  provider_http: "Provider returned an HTTP error.",
  provider_configuration: "Unsafe provider transport configuration.",
};

/** Contains only allowlisted information; never retain upstream exceptions or bodies. */
export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, public readonly httpStatus?: number) {
    super(messages[code]);
    this.name = "ProviderError";
  }
}

const blocked4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked4.addSubnet(address, prefix, "ipv4");
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20],
] as const) blocked6.addSubnet(address, prefix, "ipv6");

function publicAddress(address: string): 4 | 6 {
  const family = isIP(address);
  if (family === 4 && !blocked4.check(address, "ipv4")) return 4;
  if (family === 6 && global6.check(address, "ipv6") && !blocked6.check(address, "ipv6")) return 6;
  throw new ProviderError("endpoint_not_public");
}

function validateUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new ProviderError("invalid_endpoint"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || !hostname || url.username || url.password || url.search || url.hash ||
      input.includes("?") || input.includes("#") || hostname.includes("%") ||
      (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535))) {
    throw new ProviderError("invalid_endpoint");
  }
  const dnsName = hostname.toLowerCase().replace(/\.$/, "");
  if (dnsName === "localhost" || dnsName.endsWith(".localhost")) throw new ProviderError("endpoint_not_public");
  if (isIP(hostname)) publicAddress(hostname);
  return url;
}

/** Static validation only. DNS validation is always repeated at execution. */
export function normalizeProviderBaseUrl(input: string): string {
  if (input.length > 2048) throw new ProviderError("invalid_endpoint");
  return validateUrl(input.trim()).toString().replace(/\/+$/, "");
}

async function resolveTarget(url: URL, resolve: typeof lookup): Promise<{ address: string; family: 4 | 6 }> {
  const checked = validateUrl(url.toString());
  const hostname = checked.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return { address: hostname, family: publicAddress(hostname) };
  let answers;
  try { answers = await resolve(hostname, { all: true, verbatim: true }); }
  catch { throw new ProviderError("dns_failed"); }
  if (!answers.length) throw new ProviderError("dns_failed");
  const targets = answers.map(({ address }) => ({ address, family: publicAddress(address) }));
  return targets[0];
}

export function resolvePublicProviderTarget(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  return resolveTarget(url, lookup);
}

export type ProviderPost = (url: URL, headers: Readonly<Record<string, string>>, body: unknown) => Promise<unknown>;

/** Injection exists only in code for isolated tests; never via runtime configuration. */
export function createProviderPost(deps: { resolve: typeof lookup; request: typeof request }): ProviderPost {
  return (url, headers, body) => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
        ["1", "curl"].includes(process.env.BUN_CONFIG_VERBOSE_FETCH || "")) {
      reject(new ProviderError("provider_configuration"));
      return promise;
    }
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let connectTimer: NodeJS.Timeout | undefined;
    let finished = false;
    const totalTimer = setTimeout(() => finish(new ProviderError("provider_timeout")), 30_000);
    const finish = (error?: ProviderError, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      if (error) {
        response?.destroy();
        req?.destroy();
        reject(error);
      } else resolve(value);
    };
    void (async () => {
      try {
        const checked = validateUrl(url.toString());
        const target = await resolveTarget(checked, deps.resolve);
        if (finished) return;
        const hostname = checked.hostname.replace(/^\[|\]$/g, "");
        const payload = JSON.stringify(body);
        const options: RequestOptions & { autoSelectFamily: false } = {
          method: "POST", agent: false, family: target.family, autoSelectFamily: false,
          rejectUnauthorized: true, servername: isIP(hostname) ? "" : hostname,
          maxHeaderSize: 16 * 1024,
          lookup: (_hostname, options, callback) => {
            if (typeof options === "object" && options.all) callback(null, [target]);
            else callback(null, target.address, target.family);
          },
          headers: { ...headers, "Content-Type": "application/json", "Accept-Encoding": "identity", "Content-Length": Buffer.byteLength(payload) },
        };
        req = deps.request(checked, options, (res) => {
          response = res;
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400) { finish(new ProviderError("provider_redirect")); return; }
          if (status < 200 || status >= 300) { finish(new ProviderError("provider_http", status)); return; }
          const encoding = res.headers["content-encoding"];
          if (encoding && encoding.toLowerCase() !== "identity") { finish(new ProviderError("provider_invalid_response")); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            if (finished) return;
            size += chunk.length;
            if (size > 1024 * 1024) { finish(new ProviderError("provider_response_too_large")); return; }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (finished) return;
            try { finish(undefined, JSON.parse(Buffer.concat(chunks, size).toString("utf8"))); }
            catch { finish(new ProviderError("provider_invalid_response")); }
          });
          res.on("aborted", () => finish(new ProviderError("provider_network")));
          res.on("error", () => finish(new ProviderError("provider_network")));
        });
        req.on("socket", (socket) => {
          connectTimer = setTimeout(() => finish(new ProviderError("provider_timeout")), 5000);
          socket.once("secureConnect", () => clearTimeout(connectTimer));
        });
        req.on("error", (error: NodeJS.ErrnoException) => finish(new ProviderError(
          error.code === "HPE_HEADER_OVERFLOW" ? "provider_response_too_large" : "provider_network",
        )));
        req.end(payload);
      } catch (error) {
        finish(error instanceof ProviderError ? error : new ProviderError("provider_network"));
      }
    })();
    return promise;
  };
}

export const postProviderJson: ProviderPost = createProviderPost({ resolve: lookup, request });
