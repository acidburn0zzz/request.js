import { isPlainObject } from "is-plain-object";
import { RequestError } from "@octokit/request-error";
import type { EndpointInterface } from "@octokit/types";

import getBuffer from "./get-buffer-response";

export default function fetchWrapper(
  requestOptions: ReturnType<EndpointInterface>,
) {
  const log =
    requestOptions.request && requestOptions.request.log
      ? requestOptions.request.log
      : console;
  const parseSuccessResponseBody =
    requestOptions.request?.parseSuccessResponseBody !== false;

  if (
    isPlainObject(requestOptions.body) ||
    Array.isArray(requestOptions.body)
  ) {
    requestOptions.body = JSON.stringify(requestOptions.body);
  }

  let headers: { [header: string]: string } = {};
  let status: number;
  let url: string;

  let { fetch } = globalThis;
  if (requestOptions.request?.fetch) {
    fetch = requestOptions.request.fetch;
  }

  if (!fetch) {
    throw new Error(
      "fetch is not set. Please pass a fetch implementation as new Octokit({ request: { fetch }}). Learn more at https://github.com/octokit/octokit.js/#fetch-missing",
    );
  }

  return fetch(requestOptions.url, {
    method: requestOptions.method,
    body: requestOptions.body,
    headers: requestOptions.headers as HeadersInit,
    signal: requestOptions.request?.signal,
    // duplex must be set if request.body is ReadableStream or Async Iterables.
    // See https://fetch.spec.whatwg.org/#dom-requestinit-duplex.
    ...(requestOptions.body && { duplex: "half" }),
  })
    .then(async (response) => {
      url = response.url;
      status = response.status;

      for (const keyAndValue of response.headers) {
        headers[keyAndValue[0]] = keyAndValue[1];
      }

      if ("deprecation" in headers) {
        const matches =
          headers.link && headers.link.match(/<([^>]+)>; rel="deprecation"/);
        const deprecationLink = matches && matches.pop();
        log.warn(
          `[@octokit/request] "${requestOptions.method} ${
            requestOptions.url
          }" is deprecated. It is scheduled to be removed on ${headers.sunset}${
            deprecationLink ? `. See ${deprecationLink}` : ""
          }`,
        );
      }

      if (status === 204 || status === 205) {
        return;
      }

      // GitHub API returns 200 for HEAD requests
      if (requestOptions.method === "HEAD") {
        if (status < 400) {
          return;
        }

        throw new RequestError(response.statusText, status, {
          response: {
            url,
            status,
            headers,
            data: undefined,
          },
          request: requestOptions,
        });
      }

      if (status === 304) {
        throw new RequestError("Not modified", status, {
          response: {
            url,
            status,
            headers,
            data: await getResponseData(response),
          },
          request: requestOptions,
        });
      }

      if (status >= 400) {
        const data = await getResponseData(response);

        const error = new RequestError(toErrorMessage(data), status, {
          response: {
            url,
            status,
            headers,
            data,
          },
          request: requestOptions,
        });

        throw error;
      }

      return parseSuccessResponseBody
        ? await getResponseData(response)
        : response.body;
    })
    .then((data) => {
      return {
        status,
        url,
        headers,
        data,
      };
    })
    .catch((error) => {
      if (error instanceof RequestError) throw error;
      else if (error.name === "AbortError") throw error;

      throw new RequestError(error.message, 500, {
        request: requestOptions,
      });
    });
}

async function getResponseData(response: Response) {
  const contentType = response.headers.get("content-type");
  if (/application\/json/.test(contentType!)) {
    return response.json();
  }

  if (!contentType || /^text\/|charset=utf-8$/.test(contentType)) {
    return response.text();
  }

  return getBuffer(response);
}

function toErrorMessage(data: any) {
  if (typeof data === "string") return data;

  // istanbul ignore else - just in case
  if ("message" in data) {
    if (Array.isArray(data.errors)) {
      return `${data.message}: ${data.errors.map(JSON.stringify).join(", ")}`;
    }

    return data.message;
  }

  // istanbul ignore next - just in case
  return `Unknown error: ${JSON.stringify(data)}`;
}
