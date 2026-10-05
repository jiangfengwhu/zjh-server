import sanitizeHtml from "sanitize-html";

export type PostContent = { format: "html"; version: 1; html: string };
const color = /^(?:#[\da-f]{3,8}|[a-z]{1,20}|rgba?\([\d.,%\s]+\))$/i;
const spacing =
  /^(?:(?:[0-4]?\d)(?:px)?|0)(?:\s+(?:(?:[0-4]?\d)(?:px)?|0)){0,3}$/;
const size = /^(?:0|[1-9]\d{0,2}px|(?:\d{1,2}|100)%)$/;
const styles: Record<string, RegExp[]> = {
  color: [color],
  background: [color],
  "background-color": [color],
  border: [/^(?:0|[0-8](?:\.5)?px)\s+(?:solid|dashed|dotted)\s+(?:#[\da-f]{3,8}|[a-z]{1,20}|rgba?\([\d.,%\s]+\))$/i],
  "border-color": [color],
  "font-size": [/^(?:[89]|[1-5]\d|6[0-4])px$/],
  "font-weight": [/^(?:normal|bold|[1-9]00)$/],
  "font-style": [/^(?:normal|italic)$/],
  "letter-spacing": [/^(?:0|[0-8](?:\.\d{1,2})?px)$/],
  "text-align": [/^(?:left|center|right|justify)$/],
  "text-decoration": [/^(?:none|underline|line-through)$/],
  "line-height": [/^(?:[1-3](?:\.\d{1,2})?|(?:[1-8]\d)px)$/],
  padding: [spacing],
  margin: [spacing, /^(?:auto|0|[0-4]?\dpx)(?:\s+(?:auto|0|[0-4]?\dpx)){0,3}$/],
  gap: [spacing],
  "padding-left": [spacing],
  "padding-right": [spacing],
  "padding-top": [spacing],
  "padding-bottom": [spacing],
  "margin-left": [spacing],
  "margin-right": [spacing],
  "margin-top": [spacing],
  "margin-bottom": [spacing],
  "border-width": [/^(?:0|[0-8](?:\.5)?px)$/],
  "border-style": [/^(?:solid|dashed|dotted)$/],
  "border-radius": [spacing],
  width: [size],
  height: [size],
  "max-width": [size],
  "min-width": [size],
  flex: [/^(?:0|[1-9]|10)$/],
  "flex-grow": [/^(?:0|[1-9]|10)$/],
  "flex-shrink": [/^(?:0|[1-9]|10)$/],
  "flex-basis": [size],
  display: [/^(?:block|inline|flex)$/],
  "flex-direction": [/^(?:row|column)$/],
  "flex-wrap": [/^(?:wrap|nowrap)$/],
  "align-items": [/^(?:flex-start|center|flex-end|stretch)$/],
  "justify-content": [
    /^(?:flex-start|center|flex-end|space-between|space-around)$/,
  ],
};

/** Public display snapshot only; never accepts scripts or app-local resources. */
export function normalizePostContent(input: unknown): PostContent | undefined {
  if (input == null) return;
  const content = input as Partial<PostContent>;
  if (
    typeof input !== "object" ||
    content.format !== "html" ||
    content.version !== 1 ||
    typeof content.html !== "string" ||
    new TextEncoder().encode(content.html).length > 32768
  )
    throw new Error("HTML 内容无效或超过 32 KB");
  if ((content.html.match(/</g)?.length ?? 0) > 512)
    throw new Error("HTML 元素过多，请简化内容");
  const html = sanitizeHtml(content.html, {
    allowedTags: [
      "div",
      "p",
      "span",
      "h1",
      "h2",
      "h3",
      "h4",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "br",
      "hr",
      "ul",
      "ol",
      "li",
      "blockquote",
      "pre",
      "code",
      "a",
      "img",
    ],
    allowedAttributes: {
      "*": ["style"],
      a: ["href", "title"],
      img: ["src", "alt", "width", "height"],
    },
    allowedStyles: { "*": styles },
    allowedSchemes: ["https", "zijinhua"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    nestingLimit: 20,
    transformTags: {
      img: (_tag, attrs) => {
        const next = { ...attrs };
        for (const key of ["width", "height"])
          if (next[key] && !/^[1-9]\d{0,2}$/.test(next[key])) delete next[key];
        return { tagName: "img", attribs: next };
      },
    },
  }).trim();
  if (
    !html ||
    (!sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim() &&
      !/<img\s[^>]*src=/.test(html))
  )
    throw new Error("HTML 需包含可展示的文字或图片");
  return { format: "html", version: 1, html };
}
