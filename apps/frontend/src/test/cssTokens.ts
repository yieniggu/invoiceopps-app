/**
 * Test-only helpers to read CSS custom properties out of a stylesheet and
 * resolve them like the browser would (var() chains, cycles, color syntaxes).
 */

export type TokenMap = Record<string, string>;
export type Rgba = { r: number; g: number; b: number; a: number };

function stripComments(css: string) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Custom properties declared by the top-level rule(s) whose selector is
 * exactly `selector`. Braces are matched by depth, so nested at-rules cannot
 * end a block early; comments are ignored; later declarations win.
 */
export function readTokens(css: string, selector: string): TokenMap {
  const source = stripComments(css);
  const map: TokenMap = {};
  let found = false;
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = -1;
  let currentSelector = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      if (depth === 0) {
        currentSelector = source
          .slice(selectorStart, i)
          .replace(/\s+/g, " ")
          .trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        if (currentSelector === selector) {
          found = true;
          const body = source.slice(bodyStart, i);
          for (const [, name, value] of body.matchAll(
            /(--[\w-]+)\s*:\s*([^;]+);?/g,
          )) {
            map[name as string] = (value as string).trim();
          }
        }
        selectorStart = i + 1;
      }
    } else if (char === ";" && depth === 0) {
      selectorStart = i + 1;
    }
  }
  if (!found) throw new Error(`missing block ${selector}`);
  return map;
}

const VAR = /var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g;

/** Follows var() references. Throws on a self reference or a cycle. */
export function resolveToken(
  map: TokenMap,
  name: string,
  trail: string[] = [],
): string {
  if (trail.includes(name)) {
    throw new Error(`circular reference: ${[...trail, name].join(" -> ")}`);
  }
  const raw = map[name];
  if (raw === undefined) throw new Error(`undefined token ${name}`);
  return raw.replace(VAR, (_, ref: string) =>
    resolveToken(map, ref, [...trail, name]),
  );
}

function channel(value: string, scale: number) {
  return value.endsWith("%")
    ? (parseFloat(value) / 100) * scale
    : parseFloat(value);
}

function alphaOf(value: string | undefined) {
  if (value === undefined) return 1;
  return value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Hex (3/4/6/8 digits), rgb()/rgba() and hsl()/hsla(), comma or space syntax. */
export function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hex) {
    const full =
      hex.length <= 4
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    const [r, g, b, a] = [0, 2, 4, 6].map((i) =>
      full.length > i ? parseInt(full.slice(i, i + 2), 16) : 255,
    ) as [number, number, number, number];
    return { r, g, b, a: a / 255 };
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]+?)\s*\)$/i.exec(text);
  if (fn) {
    const parts = (fn[2] as string).split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const [p0, p1, p2, p3] = parts as [
        string,
        string,
        string,
        string | undefined,
      ];
      if (fn[1]!.toLowerCase().startsWith("rgb")) {
        return {
          r: channel(p0, 255),
          g: channel(p1, 255),
          b: channel(p2, 255),
          a: alphaOf(p3),
        };
      }
      const [r, g, b] = hslToRgb(
        parseFloat(p0),
        parseFloat(p1) / 100,
        parseFloat(p2) / 100,
      );
      return { r, g, b, a: alphaOf(p3) };
    }
  }
  throw new Error(`not a concrete color: ${value}`);
}

function luminance({ r, g, b }: Rgba) {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast ratio between two opaque colors. */
export function contrastRatio(a: string, b: string) {
  const [ca, cb] = [parseColor(a), parseColor(b)];
  if (ca.a !== 1 || cb.a !== 1) throw new Error("contrast needs opaque colors");
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}
