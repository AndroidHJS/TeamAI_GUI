export interface AnsiSegment {
  text: string;
  className?: string;
  bold?: boolean;
}

const foreground: Record<number, string> = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

const OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const SGR = /\u001b\[([0-9;]*)m/g;
const OTHER_CONTROL = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function parseAnsi(input: string): AnsiSegment[] {
  const safe = input.replace(OSC, "");
  const result: AnsiSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let cursor = 0;

  for (const match of safe.matchAll(SGR)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      result.push({
        text: safe.slice(cursor, index).replace(OTHER_CONTROL, ""),
        className: color,
        bold,
      });
    }

    const codes = (match[1] || "0").split(";").map(Number);
    for (const code of codes) {
      if (code === 0) {
        color = undefined;
        bold = false;
      } else if (code === 1) {
        bold = true;
      } else if (code === 22) {
        bold = false;
      } else if (code === 39) {
        color = undefined;
      } else if (foreground[code]) {
        color = foreground[code];
      }
    }
    cursor = index + match[0].length;
  }

  if (cursor < safe.length) {
    result.push({
      text: safe.slice(cursor).replace(OTHER_CONTROL, ""),
      className: color,
      bold,
    });
  }

  return result.filter((part) => part.text.length > 0);
}

