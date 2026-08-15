function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(level, ...args) {
  const message = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  process.stdout.write(`[${timestamp()}] [${level}] ${message}\n`);
}

function error(...args) {
  const message = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  process.stderr.write(`[${timestamp()}] [ERROR] ${message}\n`);
}

module.exports = {
  info: (...args) => log("INFO", ...args),
  warn: (...args) => log("WARN", ...args),
  error
};
