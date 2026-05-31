import { NextRequest, NextResponse } from "next/server";
import { nextAuthHandler } from "@/auth";

export const runtime = "nodejs";

interface MockRes {
  status: (code: number) => MockRes;
  send: (body: unknown) => void;
  json: (body: unknown) => void;
  redirect: (url: string) => void;
  cookie: (name: string, value: string, options?: Record<string, unknown>) => void;
  end: () => void;
  setHeader: (name: string, value: string) => MockRes;
  appendHeader: (name: string, value: string) => void;
  getHeader: (name: string) => string | undefined;
  getStatusCode: () => number;
  writeHeader: (name: string, value: string) => void;
  redirectedTo: string;
  body: unknown;
  setCookieHeaders: string[];
}

/**
 * Bridge next-auth v4 Pages Router handler to App Router.
 * v4 expects (req, res) where req has .query, .body, .headers, .method.
 */
async function createMockReq(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const segments = pathname.replace(/\/api\/auth\//, "").split("/");

  let parsedBody: unknown = undefined;
  if (request.method === "POST") {
    try {
      parsedBody = await request.json();
    } catch {
      parsedBody = undefined;
    }
  }

  return {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    query: { nextauth: segments },
    body: parsedBody,
    is: () => false,
  } as unknown as Parameters<ReturnType<typeof nextAuthHandler>>[0];
}

function createMockRes(): MockRes {
  let statusCode = 200;
  let body: unknown = null;
  let redirectedTo = "";
  const headers: Record<string, string> = {};
  const setCookieHeaders: string[] = [];

  const res: MockRes = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    send: (b: unknown) => {
      body = b;
    },
    json: (b: unknown) => {
      body = b;
    },
    redirect: (url: string) => {
      redirectedTo = url;
    },
    cookie: (name: string, value: string, options?: Record<string, unknown>) => {
      const opts = options || {};
      const parts = [`${name}=${value}`];
      if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
      if (opts.expires) parts.push(`Expires=${opts.expires}`);
      if (opts.path) parts.push(`Path=${opts.path}`);
      if (opts.domain) parts.push(`Domain=${opts.domain}`);
      if (opts.httpOnly) parts.push("HttpOnly");
      if (opts.secure) parts.push("Secure");
      if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
      setCookieHeaders.push(parts.join("; "));
    },
    end: () => {},
    setHeader: (name: string, value: string) => {
      headers[name] = value;
      return res;
    },
    appendHeader: (name: string, value: string) => {
      if (name.toLowerCase() === "set-cookie") {
        setCookieHeaders.push(value);
      } else {
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
      }
    },
    getHeader: (name: string) => headers[name],
    getStatusCode: () => statusCode,
    writeHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    get redirectedTo() {
      return redirectedTo;
    },
    get body() {
      return body;
    },
    setCookieHeaders,
  };

  return res;
}

async function handler(request: NextRequest) {
  const mockReq = await createMockReq(request);
  const mockRes = createMockRes();

  await nextAuthHandler(mockReq, mockRes);

  const statusCode = mockRes.getStatusCode();
  const body = mockRes.body;
  const redirectedTo = mockRes.redirectedTo;

  const responseHeaders: Record<string, string> = {};
  const contentType = mockRes.getHeader("Content-Type");
  if (contentType) {
    responseHeaders["Content-Type"] = contentType;
  }

  // Build response with cookies
  let response: NextResponse;

  if (redirectedTo) {
    response = NextResponse.redirect(redirectedTo);
  } else if (typeof body === "string") {
    response = new NextResponse(body, { status: statusCode, headers: responseHeaders });
  } else {
    response = NextResponse.json(body, { status: statusCode, headers: responseHeaders });
  }

  // Forward all Set-Cookie headers (session cookies, CSRF tokens, etc.)
  for (const cookie of mockRes.setCookieHeaders) {
    response.headers.append("Set-Cookie", cookie);
  }

  return response;
}

export { handler as GET };
export { handler as POST };
