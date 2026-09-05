// Ambient shims for cross-project imports that apps/web's type-check must NOT descend into.
//
// The `@/*` specifier is a Vite alias (see vite.config.mjs) to the vendored Paperclip board
// source at server/ui/src — a SEPARATELY-built TypeScript project with its own tsconfig and
// type universe. apps/web only bridges into a handful of board entry points (CompanyBoard.tsx,
// BoardNavReporter.tsx, companyBoardPrewarm.ts); deep-checking the whole vendored tree from
// apps/web would be wrong (it is compiled by server/ui's own build). Treat board imports as
// untyped here — this mirrors the runtime reality that Vite resolves them from another tree.
declare module '@/*';
