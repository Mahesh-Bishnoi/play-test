/**
 * Strict JS-literal parser for recorder chain arguments. Strings, numbers,
 * booleans, null/undefined, RegExp, arrays, and plain objects only — anything
 * else (calls, identifiers, template interpolation) throws. This is what keeps
 * recorder content from becoming code execution in the main process.
 *
 * A nested locator chain passed to `filter({ has })` stays a string here and is
 * resolved later through the same allowlisted parser (see `locator-resolve.ts`).
 */

import { isRegexStart, PAGE_FACTORY_METHODS } from "../../shared/locator-allowlist.js";
import { unsupportedSelector } from "./errors.js";

export class LiteralParser {
  private pos = 0;
  private nesting = 0;

  constructor(
    private readonly text: string,
    private readonly full: string,
  ) {}

  parse(): unknown {
    const value = this.parseValue();
    this.skipWs();
    if (this.pos !== this.text.length) {
      throw unsupportedSelector(this.full, `unexpected trailing text in "${this.text.trim()}"`);
    }
    return value;
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === "'" || ch === '"' || ch === "`") {
      return this.parseString();
    }
    if (ch === "/") {
      return this.parseRegex();
    }
    if (ch === "[") {
      return this.parseArray();
    }
    if (ch === "{") {
      return this.parseObject();
    }
    if (ch === "-" || (ch !== undefined && /[0-9]/.test(ch))) {
      return this.parseNumber();
    }
    // A nested locator chain (`filter({ has: page.getByText('x') })`) is data:
    // keep it as a string and resolve it later through the same allowlisted
    // parser — never eval it.
    if (this.startsLocatorChain()) {
      return this.parseChainText();
    }
    return this.parseKeyword();
  }

  /** True when the upcoming token is `page.…` or a factory call (`getByText(…`). */
  private startsLocatorChain(): boolean {
    const match = /^([A-Za-z_$][\w$]*)/.exec(this.text.slice(this.pos));
    if (match === null) {
      return false;
    }
    const name = match[1] as string;
    if (name !== "page" && !PAGE_FACTORY_METHODS.has(name)) {
      return false;
    }
    let next = this.pos + name.length;
    while (next < this.text.length && /\s/.test(this.text[next] as string)) {
      next++;
    }
    const ch = this.text[next];
    return name === "page" ? ch === "." : ch === "(" || ch === ".";
  }

  /**
   * Consume a balanced locator-chain expression (strings/regex/parens/braces
   * tracked) up to a top-level `,` / `}` / `]` and return it verbatim.
   */
  private parseChainText(): string {
    const start = this.pos;
    let depth = 0;
    let quote: string | null = null;
    let escaped = false;
    let inRegex = false;
    let inRegexClass = false;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos] as string;
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
        this.pos++;
        continue;
      }
      if (inRegex) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "[") {
          inRegexClass = true;
        } else if (ch === "]") {
          inRegexClass = false;
        } else if (ch === "/" && !inRegexClass) {
          inRegex = false;
          while (
            this.pos + 1 < this.text.length &&
            /[a-z]/i.test(this.text[this.pos + 1] as string)
          ) {
            this.pos++;
          }
        }
        this.pos++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        this.pos++;
        continue;
      }
      if (ch === "/" && isRegexStart(this.text, this.pos)) {
        inRegex = true;
        this.pos++;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        depth++;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0 && (ch === "]" || ch === "}")) {
          break;
        }
        depth--;
      } else if (ch === "," && depth === 0) {
        break;
      }
      this.pos++;
    }
    const chain = this.text.slice(start, this.pos).trim();
    if (chain === "") {
      throw unsupportedSelector(this.full, "empty locator chain");
    }
    return chain;
  }

  private parseString(): string {
    const quote = this.text[this.pos] as string;
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) {
        throw unsupportedSelector(this.full, "unterminated string");
      }
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === "\\") {
        out += this.parseEscape(quote);
        continue;
      }
      if (quote === "`" && ch === "$" && this.text[this.pos + 1] === "{") {
        throw unsupportedSelector(this.full, "template interpolation is not supported");
      }
      out += ch;
      this.pos++;
    }
  }

  private parseEscape(quote: string): string {
    // this.text[this.pos] is the backslash here.
    this.pos++;
    const ch = this.text[this.pos];
    if (ch === undefined) {
      throw unsupportedSelector(this.full, "unterminated escape");
    }
    this.pos++;
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      case "'":
        return "'";
      case '"':
        return '"';
      case "`":
        return "`";
      case "$":
        return "$";
      case "/":
        return "/";
      case "u": {
        const hex = this.text.slice(this.pos, this.pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw unsupportedSelector(this.full, "bad unicode escape");
        }
        this.pos += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        if (ch === quote) {
          return quote;
        }
        throw unsupportedSelector(this.full, `unsupported escape "\\${ch}"`);
    }
  }

  private parseRegex(): RegExp {
    this.pos++;
    let pattern = "";
    let inClass = false;
    let escaped = false;
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined || ch === "\n") {
        throw unsupportedSelector(this.full, "unterminated regex");
      }
      if (escaped) {
        pattern += `\\${ch}`;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "[") {
        inClass = true;
        pattern += ch;
      } else if (ch === "]") {
        inClass = false;
        pattern += ch;
      } else if (ch === "/" && !inClass) {
        break;
      } else {
        pattern += ch;
      }
      this.pos++;
    }
    this.pos++;
    let flags = "";
    while (this.pos < this.text.length && /[a-z]/i.test(this.text[this.pos] as string)) {
      flags += this.text[this.pos];
      this.pos++;
    }
    if (/[^dgimsuvy]/.test(flags) || new Set(flags).size !== flags.length) {
      throw unsupportedSelector(this.full, `bad regex flags "/${flags}"`);
    }
    try {
      return new RegExp(pattern, flags);
    } catch {
      throw unsupportedSelector(this.full, "invalid regex");
    }
  }

  private parseArray(): unknown[] {
    this.pos++;
    this.enterNested();
    try {
      const items: unknown[] = [];
      for (;;) {
        this.skipWs();
        if (this.text[this.pos] === "]") {
          this.pos++;
          return items;
        }
        if (this.text[this.pos] === undefined) {
          throw unsupportedSelector(this.full, "unterminated array");
        }
        items.push(this.parseValue());
        this.skipWs();
        const ch = this.text[this.pos];
        if (ch === ",") {
          this.pos++;
          continue;
        }
        if (ch === "]") {
          this.pos++;
          return items;
        }
        throw unsupportedSelector(this.full, 'expected "," or "]"');
      }
    } finally {
      this.nesting--;
    }
  }

  private parseObject(): Record<string, unknown> {
    this.pos++;
    this.enterNested();
    try {
      const obj: Record<string, unknown> = {};
      for (;;) {
        this.skipWs();
        if (this.text[this.pos] === "}") {
          this.pos++;
          return obj;
        }
        if (this.text[this.pos] === undefined) {
          throw unsupportedSelector(this.full, "unterminated object");
        }
        const key = this.parseKey();
        this.skipWs();
        if (this.text[this.pos] !== ":") {
          throw unsupportedSelector(this.full, `expected ":" after key "${key}"`);
        }
        this.pos++;
        obj[key] = this.parseValue();
        this.skipWs();
        const ch = this.text[this.pos];
        if (ch === ",") {
          this.pos++;
          continue;
        }
        if (ch === "}") {
          this.pos++;
          return obj;
        }
        throw unsupportedSelector(this.full, 'expected "," or "}"');
      }
    } finally {
      this.nesting--;
    }
  }

  private enterNested(): void {
    this.nesting++;
    if (this.nesting > 20) {
      throw unsupportedSelector(this.full, "nesting too deep");
    }
  }

  private parseKey(): string {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === "'" || ch === '"' || ch === "`") {
      return this.parseString();
    }
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
    if (match === null) {
      throw unsupportedSelector(this.full, "bad object key");
    }
    this.pos += match[0].length;
    return match[0];
  }

  private parseNumber(): number {
    const match =
      /^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        this.text.slice(this.pos),
      );
    if (match === null) {
      throw unsupportedSelector(
        this.full,
        `bad number near "${this.text.slice(this.pos, this.pos + 10)}"`,
      );
    }
    this.pos += match[0].length;
    const value = Number(match[0]);
    if (Number.isNaN(value)) {
      throw unsupportedSelector(this.full, `bad number "${match[0]}"`);
    }
    return value;
  }

  private parseKeyword(): unknown {
    const match = /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.pos));
    if (match === null) {
      throw unsupportedSelector(this.full, `unexpected character "${this.text[this.pos] ?? ""}"`);
    }
    const word = match[0];
    this.pos += word.length;
    switch (word) {
      case "true":
        return true;
      case "false":
        return false;
      case "null":
        return null;
      case "undefined":
        return undefined;
      default:
        throw unsupportedSelector(this.full, `"${word}" is not a supported literal`);
    }
  }

  private skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos] as string)) {
      this.pos++;
    }
  }
}
