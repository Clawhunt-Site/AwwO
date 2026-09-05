// ClawWork's `--mode json` transcript is the SAME JSONL the Pi adapter parses
// (clawwork is a pi fork), so the UI transcript parser is reused verbatim.
export { parsePiStdoutLine as parseClawworkStdoutLine } from "@paperclipai/adapter-pi-local/ui";
