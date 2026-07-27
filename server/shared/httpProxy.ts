import { request, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";

export interface HttpProxyTarget {
  host: string;
  port: number;
}

function destroyQuietly(
  stream: { destroy?: (error?: Error) => void; destroyed?: boolean },
  error?: Error,
): void {
  if (!stream.destroyed) stream.destroy?.(error);
}

export function proxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  target: HttpProxyTarget,
): void {
  const headers = { ...req.headers, host: `${target.host}:${target.port}` };
  let upstreamResponse: IncomingMessage | undefined;
  let upstream: ClientRequest;

  const destroyUpstream = (error?: Error) => {
    destroyQuietly(upstream, error);
    if (upstreamResponse) destroyQuietly(upstreamResponse, error);
  };

  const onRequestAborted = () => destroyUpstream();
  const onRequestError = (error: Error) => destroyUpstream(error);
  const onResponseError = (error: Error) => destroyUpstream(error);
  const onResponseClose = () => {
    if (!res.writableFinished) destroyUpstream();
  };

  upstream = request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers,
  }, (nextResponse) => {
    upstreamResponse = nextResponse;

    if (res.destroyed) {
      destroyUpstream();
      return;
    }

    nextResponse.on("aborted", () => destroyQuietly(res));
    nextResponse.on("error", (error) => destroyQuietly(res, error));
    res.writeHead(nextResponse.statusCode || 502, nextResponse.headers);
    nextResponse.pipe(res);
  });

  upstream.on("error", (error) => {
    if (!res.headersSent && !res.destroyed) {
      const body = JSON.stringify({ ok: false, error: `pi-web child unavailable: ${error.message}` });
      res.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      destroyQuietly(res, error);
    }
  });

  req.once("aborted", onRequestAborted);
  req.once("error", onRequestError);
  res.once("error", onResponseError);
  res.once("close", onResponseClose);
  req.pipe(upstream);
}
