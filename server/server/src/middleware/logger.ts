import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactSensitive, sanitizeLogValueForUrl, sanitizeUrlForLog } from "./redact-sensitive.js";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

function resolveLogLevel(): LogLevel {
  const configured = process.env.AWWO_LOG_LEVEL?.trim();
  if (!configured) return "debug";
  if ((LOG_LEVELS as readonly string[]).includes(configured)) return configured as LogLevel;
  throw new Error(`AWWO_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
}

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logLevel = resolveLogLevel();
const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: logLevel,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    'res.headers["set-cookie"]',
  ],
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "trace",
    },
  ],
}));

function requestUrl(req: { url?: unknown; originalUrl?: unknown }): string {
  if (typeof req.originalUrl === "string") return req.originalUrl;
  return typeof req.url === "string" ? req.url : "";
}

function sanitizeRequestRecord(req: Record<string, unknown>): Record<string, unknown> {
  const url = requestUrl(req);
  return sanitizeLogValueForUrl(redactSensitive(req), url) as Record<string, unknown>;
}

function sanitizeRequestValue(value: unknown, url: string): unknown {
  return redactSensitive(sanitizeLogValueForUrl(value, url));
}

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    req(req) {
      return sanitizeRequestRecord(req as unknown as Record<string, unknown>);
    },
  },
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${sanitizeUrlForLog(requestUrl(req))} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const url = requestUrl(req);
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    const safeMessage = sanitizeLogValueForUrl(String(errMsg), url);
    return `${req.method} ${sanitizeUrlForLog(url)} ${res.statusCode} — ${safeMessage}`;
  },
  customErrorObject(req, _res, err, loggableObject) {
    const url = requestUrl(req);
    return {
      ...loggableObject,
      err: sanitizeRequestValue(err, url),
    };
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const url = requestUrl(req);
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: sanitizeRequestValue(ctx.error, url),
          reqBody: sanitizeRequestValue(ctx.reqBody, url),
          reqParams: sanitizeRequestValue(ctx.reqParams, url),
          reqQuery: sanitizeRequestValue(ctx.reqQuery, url),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = sanitizeRequestValue(body, url);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = sanitizeRequestValue(params, url);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = sanitizeRequestValue(query, url);
      }
      if ((req as any).route?.path) {
        props.routePath = sanitizeUrlForLog(String((req as any).route.path));
      }
      return props;
    }
    return {};
  },
});
