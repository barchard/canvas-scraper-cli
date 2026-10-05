/**
 * Runs inside the page (puppeteer page.evaluate): converts the article body to
 * Markdown. Prefers <article>, then <main>, then <body>; skips nav/ads/scripts.
 * Dependency-free so it serialises cleanly.
 * @returns {{title: string, markdown: string}}
 */
export function extractMarkdown() {
  const root = document.querySelector("article") || document.querySelector("main") || document.body;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "ASIDE", "FORM", "BUTTON", "IFRAME", "SVG", "HEADER"]);
  const out = [];
  const inline = (n) => {
    if (n.nodeType === 3) return n.textContent.replace(/\s+/g, " ");
    if (n.nodeType !== 1 || SKIP.has(n.tagName)) return "";
    const inner = Array.from(n.childNodes).map(inline).join("");
    switch (n.tagName) {
      case "A": {
        const href = n.href;
        return href && inner.trim() ? `[${inner.trim()}](${href})` : inner;
      }
      case "STRONG": case "B": return inner.trim() ? `**${inner.trim()}**` : inner;
      case "EM": case "I": return inner.trim() ? `*${inner.trim()}*` : inner;
      case "BR": return "\n";
      default: return inner;
    }
  };
  const block = (n) => {
    if (n.nodeType !== 1 || SKIP.has(n.tagName)) return;
    const t = n.tagName;
    if (/^H[1-6]$/.test(t)) {
      const x = inline(n).trim();
      if (x) out.push(`${"#".repeat(Number(t[1]))} ${x}`);
    } else if (t === "P") {
      const x = inline(n).trim();
      if (x) out.push(x);
    } else if (t === "BLOCKQUOTE") {
      const x = inline(n).trim();
      if (x) out.push(x.split("\n").map((l) => `> ${l}`).join("\n"));
    } else if (t === "UL" || t === "OL") {
      const items = Array.from(n.children).filter((c) => c.tagName === "LI").map((li, i) => `${t === "OL" ? i + 1 + "." : "-"} ${inline(li).trim()}`);
      if (items.length) out.push(items.join("\n"));
    } else if (t === "FIGCAPTION") {
      const x = inline(n).trim();
      if (x) out.push(`*${x}*`);
    } else {
      Array.from(n.children).forEach(block);
    }
  };
  block(root);
  const title = (document.querySelector("h1") || {}).textContent || document.title || "";
  return { title: title.trim(), markdown: out.join("\n\n") };
}
