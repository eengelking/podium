// Types for client.mjs, so TypeScript can import it. (NodeNext looks for `client.d.mts` beside `client.mjs`.)
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from 'node:http';

export const UPSTREAM_TIMEOUT_MS: number;
/** Request headers that describe the hop to the client, not the request itself. */
export const HOP_HEADERS: ReadonlySet<string>;

export interface TlsClientOptions {
  /** The reporter config file: the CA certificates, the person's certificate and the key. */
  configPath: string;
  /** The Podium server, an https URL. */
  serverUrl: string;
  /** Hears what a caller may want to show, such as `renewal failed: ...`. Default: nothing. */
  log?: (line: string) => void;
  /** Supplies PODIUM_RENEW_BEFORE_SECONDS and PODIUM_RENEW_CHECK_SECONDS. Default: process.env. */
  env?: Record<string, string | undefined>;
}
export interface Refusal {
  status: number;
  code: string;
  message: string;
}
export interface Route {
  method: string;
  path: string;
}
export interface OpenHandlers {
  onResponse: (res: IncomingMessage) => void;
  onError: (failure: { code: string; message: string; err: Error }) => void;
}
export interface TlsResult {
  status: number;
  ok: boolean;
  text: string;
  headers: Record<string, string>;
}
export interface TlsStatus {
  user: string;
  /** The server's origin. */
  server: string;
  /** The certificate's expiry, epoch milliseconds. */
  notAfter: number;
  expired: boolean;
  /** Why the server refused to renew, or null. */
  refused: { code: string; message: string } | null;
  renewing: boolean;
  /** Epoch milliseconds before which no renewal is tried again, or 0. */
  retryAt: number;
}
export interface TlsClient {
  /** The route to forward a request to, or the refusal to answer with. Starts a renewal (not awaited) when one is due. */
  guard(method: string, url: string): { route: Route; refusal?: undefined } | { refusal: Refusal; route?: undefined };
  /** The upstream request for a route `guard` returned; the caller writes the body into the returned request. */
  open(route: Route, headers: OutgoingHttpHeaders | Record<string, string | string[] | undefined>, handlers: OpenHandlers): ClientRequest;
  /** One buffered request. Rejects with an Error whose `code` is the helper's `x-podium-helper-error` code. */
  request(method: string, url: string, init?: { headers?: Record<string, string>; body?: string }): Promise<TlsResult>;
  /** `fetch` for a full server URL; a URL on another origin rejects with code ROUTE_NOT_ALLOWED. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<TlsResult>;
  /** Starts the renewal check and looks once now. */
  start(): void;
  /** Stops the renewal check and closes the connections. */
  stop(): void;
  /** Resolves when the renewal under way, if any, has ended. */
  settled(): Promise<void>;
  /** For a status display; never a key, a certificate or a CA. */
  status(): TlsStatus;
}
/** Throws a StartError (config.mjs): INSECURE_URL, or a CONFIG_* code from reading the file. */
export function createTlsClient(options: TlsClientOptions): TlsClient;
