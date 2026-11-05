import { getAuth } from "@/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { POST, GET } = toNextJsHandler(async (request) => (await getAuth()).handler(request));
