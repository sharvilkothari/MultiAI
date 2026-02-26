const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function ts() {
  return new Date().toISOString();
}

function fmt(level, tag, msg, meta) {
  const base = `[${ts()}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  return meta ? `${base} ${JSON.stringify(meta)}` : base;
}

export function createLogger(tag) {
  return {
    info:  (msg, meta) => CURRENT_LEVEL >= LOG_LEVELS.info  && console.log(fmt('info', tag, msg, meta)),
    warn:  (msg, meta) => CURRENT_LEVEL >= LOG_LEVELS.warn  && console.warn(fmt('warn', tag, msg, meta)),
    error: (msg, meta) => CURRENT_LEVEL >= LOG_LEVELS.error && console.error(fmt('error', tag, msg, meta)),
    debug: (msg, meta) => CURRENT_LEVEL >= LOG_LEVELS.debug && console.log(fmt('debug', tag, msg, meta)),
  };
}
