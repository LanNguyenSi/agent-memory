// MEMORY_ROUTER_DEBUG=1 enables one-liner diagnostics on stderr from any
// memory-router internal that wants to surface decision-making. stdout is
// reserved for the hook contract (see hooks/user-prompt-submit.ts), so debug
// output must NOT touch stdout. Default off keeps production hooks silent.
//
// The `[memory-router]` bracketed prefix is the project-wide convention so
// `grep '^\[memory-router\]'` catches every gated diagnostic line.
//
// One-line guarantee: callers may pass multi-line strings (YAML parser errors
// ship caret-pointer snippets that span 3-4 lines). Collapse all whitespace
// runs to a single space so the output is always one `\n`-terminated line per
// event — keeps grep/awk filters honest.
function singleLine(msg: string): string {
  return msg.replace(/\s+/g, ' ').trim();
}

function debug(msg: string): void {
  if (process.env.MEMORY_ROUTER_DEBUG !== '1') return;
  process.stderr.write(`[memory-router] ${singleLine(msg)}\n`);
}

module.exports = { debug };
