import sanitizeHtml from "sanitize-html";

export type PostContent = { format: "html"; version: 1; html: string };
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
    parseStyleAttributes: false,
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
