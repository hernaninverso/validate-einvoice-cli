#!/usr/bin/env node
/**
 * @eleata/validate-einvoice — CLI to validate EU e-invoices in CI/CD.
 *
 *   npx @eleata/validate-einvoice validate invoice.xml --format auto
 *   npx @eleata/validate-einvoice formats
 *   npx @eleata/validate-einvoice explain 00400
 *
 * Wraps the hosted eleata API (https://api.eleata.io) plus a bundled offline
 * error-code reference. Get a free API key (200/mo, no card) at
 * https://eleata.io/signup/. Exit code is non-zero when a file is invalid
 * (above the --fail-on threshold), so it fails your build before a rejection.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const VERSION = "0.1.0";
const API_BASE = (process.env.EINVOICE_API_BASE || process.env.ELEATA_API_BASE || "https://api.eleata.io").replace(/\/+$/, "");
const TIMEOUT_MS = 30_000;
const USER_AGENT = `eleata-validate-einvoice/${VERSION}`;
const FORMATS = ["auto", "peppol-bis-3", "en16931-ubl", "en16931-cii", "xrechnung-ubl", "xrechnung-cii", "factur-x", "ubl", "cii"];

type ErrorFix = { format: string; title?: string; explanation: string; suggested_fix: string; example?: string };
function loadErrorFixes(): Record<string, ErrorFix> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = JSON.parse(readFileSync(join(here, "..", "error-fixes.json"), "utf8"));
    return (raw.rules ?? {}) as Record<string, ErrorFix>;
  } catch {
    return {};
  }
}

// ---- arg parsing (no deps) -------------------------------------------------
type Parsed = { _: string[]; [k: string]: string | boolean | string[] };
function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

function die(msg: string, code = 2): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

const HELP = `eleata validate-einvoice ${VERSION} — validate EU e-invoices in CI.

Usage:
  validate-einvoice validate <file...> [--format <fmt>] [--api-key <key>] [--fail-on <error|warning|never>] [--json]
  validate-einvoice formats
  validate-einvoice explain <rule-id>
  validate-einvoice --help | --version

Formats: ${FORMATS.join(", ")}
API key: --api-key, or env EINVOICE_API_KEY / ELEATA_API_KEY. Free key: https://eleata.io/signup/
Exit code: 0 = all valid; 1 = at least one file failed (above --fail-on); 2 = usage/IO error.`;

// ---- http ------------------------------------------------------------------
async function httpRequest(url: string, init: RequestInit): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") return { error: `the eleata API did not respond within ${TIMEOUT_MS / 1000}s` };
    return { error: `could not reach the eleata API at ${API_BASE}` };
  }
}

// ---- commands --------------------------------------------------------------
async function cmdValidate(args: Parsed): Promise<number> {
  const files = args._ as string[];
  if (files.length === 0) die("no files given. Usage: validate-einvoice validate <file...>");
  const apiKey = (args["api-key"] as string) || process.env.EINVOICE_API_KEY || process.env.ELEATA_API_KEY || "";
  if (!apiKey) die("no API key. Pass --api-key or set EINVOICE_API_KEY. Free key: https://eleata.io/signup/");
  let format = (args.format as string) || "auto";
  if (!FORMATS.includes(format)) die(`unknown format '${format}'. One of: ${FORMATS.join(", ")}`);
  const failOn = ((args["fail-on"] as string) || "error").toLowerCase();
  if (!["error", "warning", "never"].includes(failOn)) die(`--fail-on must be error|warning|never`);
  const asJson = args.json === true;

  const allResults: any[] = [];
  let failed = 0;
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      die(`cannot read file: ${file}`);
    }
    const isPdf = extname(file).toLowerCase() === ".pdf";
    const r = await httpRequest(`${API_BASE}/v1/validate?format=${encodeURIComponent(format)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": isPdf ? "application/pdf" : "application/xml", "User-Agent": USER_AGENT },
      body: bytes,
    });
    if ("error" in r) die(`validation request failed: ${r.error}`, 2);
    let data: any;
    try {
      data = JSON.parse(r.text);
    } catch {
      die(`the eleata API returned a non-JSON response (HTTP ${r.status}); it may be down or rate-limiting`, 2);
    }
    if (r.status < 200 || r.status >= 300) {
      const msg = data?.error?.message || data?.detail || data?.message || `HTTP ${r.status}`;
      die(`validation request failed: ${String(msg).slice(0, 300)}`, 2);
    }

    const valid = data.valid === true;
    const detected = (typeof data.format === "string" && data.format) || format;
    const rawErrors = (Array.isArray(data.errors) && data.errors) || (Array.isArray(data.issues) && data.issues) || [];
    const errors = rawErrors.filter((e: unknown) => e && typeof e === "object");
    allResults.push({ file, valid, format: detected, errors });

    const sevRank = (s: string) => (s === "error" ? 2 : s === "warning" ? 1 : 0);
    const threshold = failOn === "error" ? 2 : failOn === "warning" ? 1 : 99;
    const breaches = errors.filter((e: any) => sevRank(String(e.severity || "error")) >= threshold);
    if (breaches.length > 0) failed++;

    if (!asJson) {
      process.stdout.write(valid ? `✓ ${file}  (${detected})\n` : `✗ ${file}  (${detected}) — ${errors.length} issue(s)\n`);
      for (const e of errors as any[]) {
        const sev = e.severity ? `[${e.severity}] ` : "";
        process.stdout.write(`  • ${sev}${e.rule_id || e.id || "?"}${e.location ? `  (at ${e.location})` : ""}\n`);
        if (e.message) process.stdout.write(`    ${e.message}\n`);
        if (e.fix_hint) process.stdout.write(`    fix: ${e.fix_hint}\n`);
      }
    }
  }

  if (asJson) process.stdout.write(JSON.stringify(allResults, null, 2) + "\n");
  return failed > 0 ? 1 : 0;
}

async function cmdFormats(): Promise<number> {
  const r = await httpRequest(`${API_BASE}/v1/formats`, { headers: { "User-Agent": USER_AGENT } });
  if ("error" in r) die(`could not list formats: ${r.error}`, 2);
  process.stdout.write(r.text.trim() + "\n");
  return 0;
}

function cmdExplain(args: Parsed): number {
  const id = (args._ as string[])[0];
  if (!id) die("usage: validate-einvoice explain <rule-id>");
  const fixes = loadErrorFixes();
  const fix = fixes[id];
  if (!fix) {
    const known = Object.keys(fixes);
    process.stdout.write(`No bundled explanation for '${id}'.${known.length ? ` Known: ${known.slice(0, 12).join(", ")}…` : ""}\nSee https://eleata.io/error/\n`);
    return 0;
  }
  process.stdout.write(`${id}${fix.title ? ` — ${fix.title}` : ""}  (${fix.format})\n\n`);
  process.stdout.write(`What it means: ${fix.explanation}\n\n`);
  process.stdout.write(`How to fix it: ${fix.suggested_fix}\n`);
  if (fix.example) process.stdout.write(`\nExample:\n${fix.example}\n`);
  process.stdout.write(`\nReference: https://eleata.io/error/${id}/\n`);
  return 0;
}

// ---- main ------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  if (cmd === "validate") return cmdValidate(args);
  if (cmd === "formats") return cmdFormats();
  if (cmd === "explain") return cmdExplain(args);
  die(`unknown command '${cmd}'. Run 'validate-einvoice --help'.`);
}

main()
  .then((code) => process.exit(code))
  .catch((e) => die((e as Error).message, 2));
