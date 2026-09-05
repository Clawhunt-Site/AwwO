// ClawWork's `--mode json` stream is the SAME JSONL the Pi adapter emits (clawwork
// is a pi fork), so the terminal formatter is reused verbatim to avoid drift.
export { printPiStreamEvent as printClawworkStreamEvent } from "@paperclipai/adapter-pi-local/cli";
