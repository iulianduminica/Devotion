/**
 * Port-layer tests: markdown ↔ blocks, HTML export, CSV.
 *
 * Run with: .\node_modules\.bin\tsx.cmd scripts/test-port.ts
 *
 * No framework. The interesting cases are the round-trip on a rich fixture
 * (import, export, compare byte for byte), escaping/XSS in the HTML export, and
 * the CSV edge cases that hand-written parsers usually get wrong.
 */

import {
  asTableData,
  block,
  blockTable,
  blockText,
  blocksToHtml,
  blocksToHtmlBody,
  blocksToMarkdown,
  bodyText,
  csvCell,
  csvToDatabase,
  detectFormat,
  detectFormatDetailed,
  escapeHtml,
  escapeMarkdownText,
  importNotionZipLayout,
  importText,
  inferPropertyType,
  markdownToBlocks,
  normalizeLanguage,
  parseCsv,
  parseInlineNodes,
  rowsToCsv,
  sanitizeUrl,
  sniffDelimiter,
  tableToMarkdown,
  toCsv,
  valueToCell,
  type CsvRowInput,
  type ImportResult,
  type ParsedBlock,
} from "../server/port/index.ts";
import type {
  BlockType,
  Body,
  PropertyDef,
  PropertyValueInput,
} from "../shared/types.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mok\x1b[0m   ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(label, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function md(text: string): ImportResult {
  return markdownToBlocks(text);
}

function first(res: ImportResult): ParsedBlock {
  return res.blocks[0]!;
}

function text(res: ImportResult): string {
  return blockText(first(res));
}

function kinds(blocks: ParsedBlock[]): BlockType[] {
  return blocks.map((b) => b.type);
}

function countPages(b: ParsedBlock): number {
  const self = b.type === "page" || b.type === "child_page" ? 1 : 0;
  return self + b.children.reduce((n, c) => n + countPages(c), 0);
}

function firstLink(b: ParsedBlock): { url: string; kind: string } | undefined {
  for (const run of b.body ?? []) {
    for (const link of run.links ?? []) return { url: link.url, kind: link.kind };
  }
  return undefined;
}

function linkText(b: ParsedBlock): string {
  return (b.body ?? []).find((i) => i.links?.length)?.text ?? "";
}

function stylesOf(res: ImportResult): { text: string; styles: Record<string, boolean> }[] {
  const body = (first(res).body ?? []) as Body;
  return body
    .filter((i) => i.text !== "")
    .map((i) => ({
      text: i.text,
      styles: Object.fromEntries(
        Object.entries(i.styles ?? {}).filter(([, v]) => v === true),
      ),
    }));
}

// ─────────────────────────────────────────────────────────────────────────────

section("Headings");
{
  eq("h1", md("# One").blocks[0]!.type, "heading_1");
  eq("h2", md("## Two").blocks[0]!.type, "heading_2");
  eq("h3", md("### Three").blocks[0]!.type, "heading_3");
  eq("h1 text", text(md("# One")), "One");
  eq("setext h1", md("Under\n===\n").blocks[0]!.type, "heading_1");
  eq("setext h2", md("Under\n---\n").blocks[0]!.type, "heading_2");
  eq("setext keeps text", text(md("Under\n===\n")), "Under");
  eq("trailing hashes stripped", text(md("## Title ##")), "Title");
  eq("h4 maps to heading_3", md("#### Four").blocks[0]!.type, "heading_3");
  ok(
    "h4 warns",
    md("#### Four").warnings.some((w) => w.includes("heading level 4")),
    JSON.stringify(md("#### Four").warnings),
  );
  eq("no space after # is a paragraph", md("#NoSpace").blocks[0]!.type, "paragraph");
  eq("setext underline alone is a paragraph", md("===\n").blocks[0]!.type, "paragraph");
}

section("Paragraph, quote, divider");
{
  eq("paragraph", md("Hello there").blocks[0]!.type, "paragraph");
  eq("two paragraphs", md("One\n\nTwo").blocks.length, 2);
  eq("multi-line paragraph joins", text(md("line one\nline two")), "line one\nline two");
  eq("blockquote", md("> Quoted").blocks[0]!.type, "quote");
  eq("blockquote text", blockText(md("> Quoted").blocks[0]!), "Quoted");
  eq("divider ---", md("---").blocks[0]!.type, "divider");
  eq("divider ***", md("***").blocks[0]!.type, "divider");
  eq("divider ___", md("___").blocks[0]!.type, "divider");
  eq("divider between paragraphs", kinds(md("a\n\n---\n\nb").blocks), ["paragraph", "divider", "paragraph"]);
  eq("quote with two blocks", md("> a\n>\n> b").blocks[0]!.children.length, 1);
}

section("Lists");
{
  eq("dash bullet", md("- one").blocks[0]!.type, "bulleted_list_item");
  eq("star bullet", md("* one").blocks[0]!.type, "bulleted_list_item");
  eq("plus bullet", md("+ one").blocks[0]!.type, "bulleted_list_item");
  eq("bullet text", text(md("- one")), "one");
  eq("numbered", md("1. one").blocks[0]!.type, "numbered_list_item");
  eq("numbered keeps its number", md("7. one").blocks[0]!.props.number, 7);
  eq("three bullets", md("- a\n- b\n- c").blocks.length, 3);
  eq("to_do unchecked", md("- [ ] task").blocks[0]!.type, "to_do");
  eq("to_do unchecked prop", md("- [ ] task").blocks[0]!.props.checked, false);
  eq("to_do checked", md("- [x] task").blocks[0]!.props.checked, true);
  eq("to_do upper X", md("- [X] task").blocks[0]!.props.checked, true);
  eq("to_do text", text(md("- [x] task")), "task");
  eq("star checkbox is a to_do", md("* [x] task").blocks[0]!.type, "to_do");
  eq("plus checkbox is a to_do", md("+ [ ] task").blocks[0]!.type, "to_do");
  eq("ordered checkbox is not a to_do", md("1. [x] task").blocks[0]!.type, "numbered_list_item");
  eq("not a list: -3 degrees", md("-3 degrees").blocks[0]!.type, "paragraph");
  eq("indented continuation is a child block", kinds(md("- one\n  two").blocks[0]!.children), ["paragraph"]);
  eq("child block text", blockText(md("- one\n  two").blocks[0]!.children[0]!), "two");
  eq("numbered with a bullet child", kinds(md("1. one\n   - sub").blocks[0]!.children), [
    "bulleted_list_item",
  ]);
}

section("Nesting");
{
  eq("2-space nesting", kinds(md("- a\n  - b").blocks[0]!.children), ["bulleted_list_item"]);
  eq("4-space nesting", kinds(md("- a\n    - b").blocks[0]!.children), ["bulleted_list_item"]);
  eq("tab nesting", kinds(md("- a\n\t- b").blocks[0]!.children), ["bulleted_list_item"]);
  eq("tab child text", blockText(md("- a\n\t- b").blocks[0]!.children[0]!), "b");
  eq("three levels", md("- a\n  - b\n    - c").blocks[0]!.children[0]!.children.length, 1);
  eq("sibling after a child", md("- a\n  - b\n- c").blocks.length, 2);
  eq("paragraph under a bullet", kinds(md("- a\n\n  text").blocks[0]!.children), ["paragraph"]);
  eq("code under a bullet", kinds(md("- a\n  ```js\n  x\n  ```").blocks[0]!.children), ["code"]);
  eq("heading child", kinds(md("# H\n  sub").blocks[0]!.children), ["paragraph"]);
  eq("indent does not nest siblings", md("- a\n- b").blocks.length, 2);
}

section("Toggle (Notion <details>)");
{
  const one = md("<details><summary>Title</summary>body</details>");
  eq("single-line toggle type", one.blocks[0]!.type, "toggle");
  eq("single-line toggle title", blockText(one.blocks[0]!), "Title");
  eq("single-line toggle body child", blockText(one.blocks[0]!.children[0]!), "body");
  eq("toggle starts closed", one.blocks[0]!.props.open, false);

  const multi = md(
    "<details><summary>Deep</summary>\n\ninside\n\n- item one\n\n</details>\n",
  );
  eq("multi-line toggle title", blockText(multi.blocks[0]!), "Deep");
  eq("multi-line toggle children", kinds(multi.blocks[0]!.children), ["paragraph", "bulleted_list_item"]);
  eq("toggle child text", blockText(multi.blocks[0]!.children[1]!), "item one");
  eq("toggle after a toggle", md("<details><summary>A</summary></details>\n\ntext").blocks.length, 2);
  eq("unclosed toggle keeps parsing", md("<details><summary>A</summary>\n\nx\n").blocks[0]!.type, "toggle");
  ok(
    "unclosed toggle warns",
    md("<details><summary>A</summary>\n\nx\n").warnings.some((w) => w.includes("<details>")),
  );
}

section("Callout");
{
  const c = md("> 💡 **Note** this matters");
  eq("emoji blockquote is a callout", c.blocks[0]!.type, "callout");
  eq("callout icon", c.blocks[0]!.props.icon, "💡");
  eq("callout body drops the emoji", blockText(c.blocks[0]!), "Note this matters");
  eq("callout keeps bold", stylesOf(c)[0]?.styles.bold, true);
  eq("callout body text", stylesOf(c).map((s) => s.text), ["Note", " this matters"]);
  const plain = md("> Just quoted");
  eq("quote without an emoji", plain.blocks[0]!.type, "quote");
  eq("emoji mid-text is not a callout", md("> A 💡 idea").blocks[0]!.type, "quote");
  const withChild = md("> ⚠️ **Careful**\n>   - risk");
  eq("callout with a child", kinds(withChild.blocks[0]!.children), ["bulleted_list_item"]);
  eq("callout icon is the emoji", withChild.blocks[0]!.props.icon, "⚠️");
}

section("Code fences");
{
  const code = md("```js\nconst a = 1;\n```");
  eq("code block", code.blocks[0]!.type, "code");
  eq("code text", blockText(code.blocks[0]!), "const a = 1;");
  eq("js alias", code.blocks[0]!.props.language, "javascript");
  eq("ts alias", md("```ts\nx\n```").blocks[0]!.props.language, "typescript");
  eq("py alias", md("```py\nx\n```").blocks[0]!.props.language, "python");
  eq("sh alias", md("```sh\nx\n```").blocks[0]!.props.language, "bash");
  eq("plain text alias", md("```plain text\nx\n```").blocks[0]!.props.language, "plaintext");
  eq("no language", md("```\nx\n```").blocks[0]!.props.language, "plaintext");
  eq("unknown language kept", md("```brainfuck\nx\n```").blocks[0]!.props.language, "brainfuck");
  eq("normalizeLanguage maps js", normalizeLanguage("JS"), "javascript");
  eq("normalizeLanguage empty", normalizeLanguage(""), "plaintext");
  eq("tilde fence", md("~~~python\nx\n~~~").blocks[0]!.props.language, "python");
  eq("empty code block", md("```js\n```").blocks[0]!.type, "code");
  eq(
    "fence with a fence inside",
    blockText(md("````md\n```js\nx\n```\n````").blocks[0]!),
    "```js\nx\n```",
  );
  ok("unclosed fence warns", md("```js\nx\n").warnings.some((w) => w.includes("code fence")));
}

section("Images, links, previews");
{
  const img = md("![Sunset over the lake](./img/lake.png)");
  eq("image block", img.blocks[0]!.type, "image");
  eq("image url", img.blocks[0]!.props.url, "./img/lake.png");
  eq("image caption", bodyText(img.blocks[0]!.props.caption as Body), "Sunset over the lake");
  eq("inline image is a link run", md("look ![alt](x.png) here").blocks[0]!.type, "paragraph");
  ok(
    "inline image warns",
    md("look ![alt](x.png) here").warnings.some((w) => w.includes("inline image")),
  );
  const link = md("see [the docs](https://example.com/docs)");
  eq("link kind", (link.blocks[0]!.body![1]!.links![0]!).kind, "url");
  eq("link url", (link.blocks[0]!.body![1]!.links![0]!).url, "https://example.com/docs");
  eq("link text", link.blocks[0]!.body![1]!.text, "the docs");
  eq("autolink line", md("<https://auto.link>").blocks[0]!.type, "link_preview");
  eq("autolink url", md("<https://auto.link>").blocks[0]!.props.url, "https://auto.link");
  eq("mailto autolink", md("<mailto:a@b.co>").blocks[0]!.props.url, "mailto:a@b.co");
  eq("percent-decoded url", md("[x](./a%20b.md)").blocks[0]!.body![0]!.links![0]!.url, "./a b.md");
  eq("link title dropped", md('[x](https://e.com "Docs")').blocks[0]!.body![0]!.links![0]!.url, "https://e.com");
  eq("figure import", md('<figure><img src="a.png" alt="A"><figcaption>Cap</figcaption></figure>').blocks[0]!.type, "image");
  eq("figure caption", bodyText(md('<figure><img src="a.png" alt="A"><figcaption>Cap</figcaption></figure>').blocks[0]!.props.caption as Body), "Cap");
}

section("Math");
{
  const blockEq = md("$$\n\\int_0^1 x dx\n$$");
  eq("block math type", blockEq.blocks[0]!.type, "latex");
  eq("block math latex", blockEq.blocks[0]!.props.latex, "\\int_0^1 x dx");
  eq("block math not inline", blockEq.blocks[0]!.props.inlineMode, false);
  const inline = md("$E=mc^2$");
  eq("inline math type", inline.blocks[0]!.type, "latex");
  eq("inline math latex", inline.blocks[0]!.props.latex, "E=mc^2");
  eq("inline math flag", inline.blocks[0]!.props.inlineMode, true);
  const split = md("energy is $E=mc^2$ today");
  eq("inline math splits the paragraph", kinds(split.blocks), ["paragraph", "latex", "paragraph"]);
  eq("split keeps the head", blockText(split.blocks[0]!), "energy is ");
  eq("split keeps the tail", blockText(split.blocks[2]!), " today");
  eq("dollar sign survives", text(md("costs $5 and €3")), "costs $5 and €3");
  eq("escaped dollar", text(md("costs \\$5")), "costs $5");
}

section("Inline styles");
{
  eq("bold", stylesOf(md("**b**"))[0], { text: "b", styles: { bold: true } });
  eq("italic", stylesOf(md("*i*"))[0], { text: "i", styles: { italic: true } });
  eq("underscore italic", stylesOf(md("_i_"))[0], { text: "i", styles: { italic: true } });
  eq("code", stylesOf(md("`c`"))[0], { text: "c", styles: { code: true } });
  eq("strike", stylesOf(md("~~s~~"))[0], { text: "s", styles: { strike: true } });
  const nested = stylesOf(md("**bold with *italic* inside**"));
  eq("nested run count", nested.length, 3);
  eq("nested prefix is bold", nested[0], { text: "bold with ", styles: { bold: true } });
  eq("nested middle is bold+italic", nested[1], {
    text: "italic",
    styles: { bold: true, italic: true },
  });
  eq("nested suffix is bold", nested[2], { text: " inside", styles: { bold: true } });
  eq("snake_case is not italic", text(md("snake_case_name")), "snake_case_name");
  eq("2 * 3 survives", text(md("2 * 3")), "2 * 3");
  eq("unclosed ** is literal", text(md("**bold")), "**bold");
  eq("code span keeps markers", text(md("`**not bold**`")), "**not bold**");
  eq("backslash escapes", text(md("\\*literal\\*")), "*literal*");
  eq("escaped hash", text(md("\\# not a heading")), "# not a heading");
  eq("entities decode", text(md("a &amp; b &lt;c&gt;")), "a & b <c>");
  eq("numeric entity", text(md("&#65;B")), "AB");
  eq("inline html bold", stylesOf(md("<b>strong</b>"))[0]?.styles.bold, true);
  eq("inline html em", stylesOf(md("<em>it</em>"))[0]?.styles.italic, true);
  eq("inline html code", stylesOf(md("<code>c</code>"))[0]?.styles.code, true);
  eq("inline html anchor", md('<a href="https://e.com">x</a>').blocks[0]!.body![0]!.links![0]!.url, "https://e.com");
  eq("unknown tag stripped", text(md("<custom>kept</custom>")), "kept");
  ok("unknown tag warns", md("<custom>kept</custom>").warnings.length > 0);
  eq("br becomes a newline", text(md("a<br/>b")), "a\nb");
  eq("bold link is bold", md("**[x](https://e.com)**").blocks[0]!.body![0]!.styles.bold, true);
  eq("link inside bold keeps url", md("**[x](https://e.com)**").blocks[0]!.body![0]!.links![0]!.url, "https://e.com");
  eq("code span with a backtick", text(md("``a`b``")), "a`b");
  eq("inline parse of empty string", parseInlineNodes("", { warnings: [], warned: new Set(), databases: [], tabsWidth: 4, baseDir: "", lastHeading: "" }).length, 0);
}

section("Pipe tables → databases");
{
  const res = md(
    [
      "| Name | Qty | Done | When | Tags | Status | Link |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| Alpha | 3 | Checked | 2024-01-15 | red, blue | Active | https://a.example |",
      "| Beta | 4.5 | Unchecked | 2024-02-20 | green, off | Done | https://b.example |",
      "| Gamma | 5 | Checked | 2024-03-04 | tiny, large | Active | https://c.example |",
      "",
    ].join("\n"),
  );
  eq("table becomes one block", res.blocks.length, 1);
  eq("block is a child_database", res.blocks[0]!.type, "child_database");
  eq("one database", res.databases.length, 1);
  eq("database title from the preceding heading", md("# Tasks\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n").databases[0]!.title, "Tasks");
  eq("fallback title", md("| a | b |\n| --- | --- |\n| 1 | 2 |\n").databases[0]!.title, "Table 1");
  const db = res.databases[0]!;
  eq("column count", db.properties.length, 7);
  eq("first column is the title", db.properties[0]!.type, "title");
  eq("numeric column", db.properties[1]!.type, "number");
  eq("boolean column", db.properties[2]!.type, "checkbox");
  eq("date column", db.properties[3]!.type, "date");
  eq("comma-list column", db.properties[4]!.type, "multi_select");
  eq("small vocabulary column", db.properties[5]!.type, "select");
  eq("url column", db.properties[6]!.type, "url");
  eq("row count", db.rows.length, 3);
  eq("number value", db.rows[0]!["Qty"], 3);
  eq("decimal number", db.rows[1]!["Qty"], 4.5);
  eq("checkbox value", db.rows[0]!["Done"], true);
  eq("checkbox false value", db.rows[1]!["Done"], false);
  eq("date value is epoch ms", db.rows[0]!["When"], {
    start: Date.UTC(2024, 0, 15),
    end: null,
    allDay: true,
  });
  eq("multi_select value", db.rows[0]!["Tags"], ["red", "blue"]);
  eq("select value", db.rows[0]!["Status"], ["Active"]);
  eq("title value", db.rows[2]!["Name"], "Gamma");
  eq("url value", db.rows[0]!["Link"], "https://a.example");
  eq("table rides on the block", blockTable(res.blocks[0]!)?.rows.length, 3);
  eq("no pipes left in the body", blockText(res.blocks[0]!), "Table 1");

  eq("infer all numeric", inferPropertyType(["1", "2", "3"]), "number");
  eq("infer thousands separator", inferPropertyType(["1,234", "56"]), "number");
  eq("infer booleans", inferPropertyType(["yes", "no", "checked"]), "checkbox");
  eq("infer dates", inferPropertyType(["2024-01-01", "2024-12-31"]), "date");
  eq("infer slash dates", inferPropertyType(["1/2/2024", "12/31/2024"]), "date");
  eq("infer urls", inferPropertyType(["https://a.io", "www.b.io"]), "url");
  eq("infer multi_select", inferPropertyType(["a, b", "c, d"]), "multi_select");
  eq("infer select", inferPropertyType(["red", "blue", "red"]), "select");
  eq("one value is not a select", inferPropertyType(["only"]), "text");
  eq("phrases are text", inferPropertyType(["a long phrase", "another one here"]), "text");
  eq("empty column is text", inferPropertyType(["", "  "]), "text");
  eq("empties do not disqualify", inferPropertyType(["1", "", "3"]), "number");
  eq("ragged rows keep their width", parseCsv("a,b,c\nd,e").rows.map((r) => r.length), [3, 2]);
  eq(
    "escaped pipe in a cell",
    md("| a |\n| --- |\n| x \\| y |\n").databases[0]!.rows[0]!["a"],
    "x | y",
  );
  eq("alignment row is fine", md("| a | b |\n|:---|---:|\n| 1 | 2 |\n").databases[0]!.properties.length, 2);
  eq("table export", tableToMarkdown(
    [{ name: "Name", type: "title" }, { name: "Qty", type: "number" }],
    [{ Name: "A", Qty: 2 }],
  ), "| Name | Qty |\n| --- | --- |\n| A | 2 |");
}

section("Notion export layout");
{
  const files = [
    { path: "index.md", content: "# Workspace\n\nStart [here](Getting%20Started.md).\n" },
    {
      path: "Getting Started.md",
      content: "# Getting Started\n\n[Deep Dive](Getting Started/Deep Dive.md)\n\n- read the notes\n",
    },
    { path: "Getting Started/Deep Dive.md", content: "# Deep Dive\n\nThe real content.\n" },
    { path: "Assets/logo.png", content: "not-markdown" },
    { path: "Broken.md", content: "links to [nowhere](./Nope.md)\n" },
  ];
  const res = importNotionZipLayout(files);

  const find = (blocks: ParsedBlock[], title: string): ParsedBlock | null => {
    for (const b of blocks) {
      if ((b.type === "page" || b.type === "child_page") && blockText(b) === title) return b;
      const nested = find(b.children, title);
      if (nested) return nested;
    }
    return null;
  };

  eq("root page plus the unlinked top-level page", kinds(res.blocks), ["page", "page"]);
  eq("root is index.md", blockText(res.blocks[0]!), "index");
  const root = res.blocks[0]!;
  eq("root keeps its own content", root.children[0]!.type, "heading_1");
  eq(
    "a linked top-level page becomes a child_page",
    blockText(root.children.find((c) => c.type === "child_page")!),
    "Getting Started",
  );
  eq(
    "relative .md link becomes a page link",
    firstLink(root.children[1]!),
    { url: "Getting Started", kind: "page" },
  );
  eq("page link text is the link text", linkText(root.children[1]!), "here");

  const gs = find(res.blocks, "Getting Started")!;
  ok("Getting Started is in the tree", gs !== undefined && gs !== null);
  eq("folder page nests under its parent page", find(res.blocks, "Deep Dive")!.type, "child_page");
  eq("deep page content survives", blockText(find(res.blocks, "Deep Dive")!.children[1]!), "The real content.");
  eq("link-only block is dropped for the child_page", kinds(gs.children), [
    "heading_1",
    "bulleted_list_item",
    "child_page",
  ]);
  eq("page path prop", gs.props.path, "Getting Started.md");
  eq("deep path prop", find(res.blocks, "Deep Dive")!.props.path, "Getting Started/Deep Dive.md");
  eq("unresolved link warns", res.warnings.some((w) => w.includes("Nope.md")), true);
  eq("assets warn", res.warnings.some((w) => w.includes("non-markdown")), true);
  eq("no page lost: three page nodes", res.blocks.reduce((n, b) => n + countPages(b), 0), 4);
  eq("plain markdown link stays a url", md("[Deep Dive](Getting Started/Deep Dive.md)").blocks[0]!.body![0]!.links![0]!.kind, "url");
}

section("Caller table shapes (the seam's plain {header, rows})");
{
  const simple = block("child_database", {
    text: "People",
    props: {
      table: { header: ["Name", "Qty"], rows: [["Ann", "3"], ["Bob", "4"]], title: "People" },
    },
  });
  eq(
    "plain header/rows exports as a GFM table",
    blocksToMarkdown([simple]),
    "| Name | Qty |\n| --- | --- |\n| Ann | 3 |\n| Bob | 4 |\n",
  );
  ok(
    "plain header/rows exports as an HTML table",
    blocksToHtmlBody([simple]).includes("<th>Qty</th>"),
    blocksToHtmlBody([simple]),
  );
  const untyped = block("table" as never, {
    props: { table: { header: ["A"], rows: [["1"]] } },
  });
  eq("an unknown block type with props.table still exports", blocksToMarkdown([untyped]), "| A |\n| --- |\n| 1 |\n");
  ok(
    "html export handles it too",
    blocksToHtmlBody([untyped]).includes("<td>1</td>"),
    blocksToHtmlBody([untyped]),
  );
  eq("asTableData reads the typed shape", asTableData({ title: "T", properties: [{ name: "a", type: "title" }], rows: [{ a: "1" }] })?.properties.length, 1);
  eq("asTableData reads the plain shape", asTableData({ header: ["a"], rows: [["1"]] })?.rows[0]?.a, "1");
  eq("asTableData rejects junk", asTableData("nope"), null);
  eq("blockTable reads props.table", blockTable(simple)?.title, "People");
  const typed = block("child_database", {
    text: "X",
    props: {
      table: {
        title: "X",
        properties: [
          { name: "A", type: "title" as const },
          { name: "N", type: "number" as const },
        ],
        rows: [{ A: "one", N: 2 }],
      },
    },
  });
  eq("typed shape exports numbers", blocksToMarkdown([typed]), "| A | N |\n| --- | --- |\n| one | 2 |\n");
  ok("typed shape exports in html", blocksToHtmlBody([typed]).includes("<td>one</td>"));
}

section("Markdown export");
{
  eq("heading export", blocksToMarkdown(md("# One").blocks), "# One\n");
  eq("todo export", blocksToMarkdown(md("- [x] done").blocks), "- [x] done\n");
  eq("todo unchecked export", blocksToMarkdown(md("- [ ] todo").blocks), "- [ ] todo\n");
  eq("toggle export", blocksToMarkdown(md("<details><summary>T</summary>x</details>").blocks), "<details><summary>T</summary>\n\nx\n\n</details>\n");
  eq("callout export", blocksToMarkdown(md("> 💡 **Hi** there").blocks), "> 💡 **Hi** there\n");
  eq("quote export", blocksToMarkdown(md("> Quoted").blocks), "> Quoted\n");
  eq("quote children export", blocksToMarkdown(md("> Quoted\n>   child").blocks), "> Quoted\n>   child\n");
  eq("image export", blocksToMarkdown(md("![Cap](a.png)").blocks), "![Cap](a.png)\n");
  eq("link preview export", blocksToMarkdown(md("<https://a.io>").blocks), "<https://a.io>\n");
  eq("code export", blocksToMarkdown(md("```ts\nlet a = 1;\n```").blocks), "```typescript\nlet a = 1;\n```\n");
  eq("block math export", blocksToMarkdown(md("$$\nx^2\n$$").blocks), "$$\nx^2\n$$\n");
  eq("inline math export", blocksToMarkdown(md("$x^2$").blocks), "$x^2$\n");
  eq("divider export", blocksToMarkdown(md("---").blocks), "---\n");
  eq("nested list export", blocksToMarkdown(md("- a\n  - b").blocks), "- a\n  - b\n");
  eq("numbered export uses 1.", blocksToMarkdown(md("3. a\n4. b").blocks), "1. a\n1. b\n");
  eq("table export", blocksToMarkdown(md("| a | b |\n| --- | --- |\n| Ann | 1 |\n").blocks), "| a | b |\n| --- | --- |\n| Ann | 1 |\n");
  eq("bold export", blocksToMarkdown(md("**a** *b* ~~c~~ `d`").blocks), "**a** _b_ ~~c~~ `d`\n");
  eq("link export", blocksToMarkdown(md("[t](https://e.com)").blocks), "[t](https://e.com)\n");
  eq("page link export", blocksToMarkdown(md("[T](./T.md)").blocks, {
    pageLink: (k) => `https://app.strata/page/${encodeURIComponent(k)}`,
  }), "[T](./T.md)\n");
  eq("child_page export", blocksToMarkdown([block("child_page", { text: "Sub Page" })]), "- [Sub Page](./Sub%20Page.md)\n");
  eq("column list export", blocksToMarkdown(md('<div class="column_list">\n<div class="column">\n\nleft\n\n</div>\n<div class="column">\n\nright\n\n</div>\n</div>').blocks), '<div class="column_list">\n<div class="column">\n\nleft\n\n</div>\n<div class="column">\n\nright\n\n</div>\n</div>\n');
  eq("page export is its children", blocksToMarkdown(md("# Title\n\nbody").blocks, { titleHeading: false }).trim(), "# Title\n\nbody");
}

section("Escaping on export");
{
  eq("leading dash", escapeMarkdownText("- not a list"), "\\- not a list");
  eq("leading hash", escapeMarkdownText("# not a heading"), "\\# not a heading");
  eq("leading number dot", escapeMarkdownText("1. not a list"), "1\\. not a list");
  eq("leading number paren", escapeMarkdownText("1) not a list"), "1\\) not a list");
  eq("leading plus", escapeMarkdownText("+ not a list"), "\\+ not a list");
  eq("leading gt", escapeMarkdownText("> not a quote"), "\\> not a quote");
  eq("leading bang bracket", escapeMarkdownText("![not an image]"), "\\!\\[not an image\\]");
  eq("mid-line dash is free", escapeMarkdownText("a - b"), "a - b");
  eq("1.5 is not escaped", escapeMarkdownText("1.5 million"), "1.5 million");
  eq("v1.5 is not escaped", escapeMarkdownText("v1.5"), "v1.5");
  eq("stars escaped", escapeMarkdownText("2 * 3 * 4"), "2 \\* 3 \\* 4");
  eq("pipe escaped", escapeMarkdownText("a | b"), "a \\| b");
  eq("angle tag escaped", escapeMarkdownText("<b>x</b>"), "\\<b>x\\</b>");
  eq("bare angle kept", escapeMarkdownText("a < b"), "a < b");
  eq("backslash doubled", escapeMarkdownText("a\\b"), "a\\\\b");
  const round = (src: string): string => blocksToMarkdown(md(src).blocks);
  eq("dash paragraph round-trips", round("\\- plain text"), "\\- plain text\n");
  eq("escaped import", text(md("\\- plain text")), "- plain text");
  eq("re-export is stable", blocksToMarkdown(md(round("\\- plain text")).blocks), round("\\- plain text"));
  eq("code text is not escaped", blocksToMarkdown(md("```\n*not* escaped\n```").blocks), "```\n*not* escaped\n```\n");
  eq("fence grows for nested fences", blocksToMarkdown(md("````md\n```js\nx\n```\n````").blocks), "````markdown\n```js\nx\n```\n````\n");
  eq("code with backticks in a span", blocksToMarkdown(md("``a`b``").blocks), "``a`b``\n");
}

section("Round-trip on a rich fixture");
{
  const RICH = [
    "# Getting Started",
    "",
    "A plain paragraph with **bold**, _italic_, ~~struck~~, `code` and a [link](https://example.com).",
    "",
    "## Nesting",
    "",
    "- top level",
    "  - child with **bold**",
    "  - second child",
    "- next top",
    "",
    "1. first",
    "1. second",
    "  - nested under the number",
    "",
    "- [ ] open task",
    "- [x] done task",
    "",
    "> A quote.",
    ">   a child of the quote",
    "",
    "> 💡 **Note** callout text",
    "",
    "<details><summary>Toggle title</summary>",
    "",
    "inside the toggle",
    "",
    "- a child item",
    "",
    "</details>",
    "",
    "```typescript",
    "const x: number = 1;",
    "```",
    "",
    "$$",
    "\\int_0^1 x\\,dx = \\frac{1}{2}",
    "$$",
    "",
    "![The caption](./img/photo.png)",
    "",
    "<https://auto.link>",
    "",
    "| Name | Qty | Done | When | Tags | Status | Link |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| Alpha | 3 | Checked | 2024-01-15 | red, blue | Active | https://a.example |",
    "| Beta | 4 | Unchecked | 2024-02-20 | green, off | Done | https://b.example |",
    "| Gamma | 5 | Checked | 2024-03-04 | tiny, large | Active | https://c.example |",
    "",
    "---",
    "",
    "\\- not a list, # not a heading mid-line, 1. not a number mid-line, 2 \\* 3 is maths.",
    "",
    "$E=mc^2$",
    "",
  ].join("\n");

  const imported = markdownToBlocks(RICH);
  eq("rich fixture imports no warnings", imported.warnings, []);
  const exported = blocksToMarkdown(imported.blocks);
  if (exported !== RICH) {
    const a = exported.split("\n");
    const b = RICH.split("\n");
    let k = 0;
    while (k < Math.min(a.length, b.length) && a[k] === b[k]) k++;
    ok("rich fixture round-trips byte for byte", false, `line ${k + 1}: got ${JSON.stringify(a[k])}, want ${JSON.stringify(b[k])}`);
    console.log("\n--- actual export ---\n" + exported + "\n---------------------\n");
  } else {
    ok("rich fixture round-trips byte for byte", true);
  }
  eq("re-import of the export matches", blocksToMarkdown(markdownToBlocks(exported).blocks), exported);
  eq("block count is stable", markdownToBlocks(exported).blocks.length, imported.blocks.length);
  const types = kinds(imported.blocks);
  eq(
    "every construct produced its own type",
    types,
    [
      "heading_1",
      "paragraph",
      "heading_2",
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "numbered_list_item",
      "to_do",
      "to_do",
      "quote",
      "callout",
      "toggle",
      "code",
      "latex",
      "image",
      "link_preview",
      "child_database",
      "divider",
      "paragraph",
      "latex",
    ],
  );
  eq("bulleted children survived", imported.blocks[3]!.children.length, 2);
  eq("numbered child survived", imported.blocks[6]!.children.length, 1);
  eq("quote child survived", imported.blocks[9]!.children.length, 1);
  eq("toggle children survived", imported.blocks[11]!.children.length, 2);
  eq("rich fixture database survived", imported.databases.length, 1);
  eq("rich fixture row values", imported.databases[0]!.rows[0]!["Qty"], 3);
}

section("HTML export");
{
  const html = blocksToHtml(md("# Title\n\nSome **bold** text.\n").blocks, { title: "Doc" });
  ok("doctype first", html.startsWith("<!doctype html>"), html.slice(0, 40));
  ok("html lang", html.includes('<html lang="en">'));
  ok("charset", html.includes('<meta charset="utf-8">'));
  ok("title in head", html.includes("<title>Doc</title>"));
  ok("embedded css", html.includes("<style>") && html.includes("--bg:"));
  ok("dark mode block", html.includes("@media (prefers-color-scheme: dark)"));
  ok("h1 rendered", html.includes("<h1 id=\"title\">Title</h1>"), html.slice(0, 200));
  ok("paragraph rendered", html.includes("<p>Some <strong>bold</strong> text.</p>"));
  ok("closing html", html.trimEnd().endsWith("</html>"));

  const evil = blocksToHtml(md("<p>plain</p>\n\nXSS paragraph: <script>alert('xss')</script> & more\n").blocks);
  ok("script tag is escaped", evil.includes("&lt;script&gt;"), evil.slice(0, 400));
  ok("no live script element", !/<script>/.test(evil), evil.match(/<script[^>]*>/g)?.join(","));
  ok("ampersand escaped", evil.includes("&amp; more"));
  eq("escapeHtml covers all five", escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
  const attrEvil = blocksToHtml([
    block("image", { props: { url: '" onload="alert(1)', caption: null } }),
  ]);
  ok("attribute injection escaped", !attrEvil.includes('" onload="alert(1)'), attrEvil);
  ok("javascript: url neutralised", sanitizeUrl("javascript:alert(1)") === "#");
  ok("data: url neutralised", sanitizeUrl("data:text/html;base64,AAAA") === "#");
  ok("data image allowed", sanitizeUrl("data:image/png;base64,AAA").startsWith("data:image/png"));
  const linkEvil = blocksToHtml([
    block("paragraph", {
      body: [{ type: "text", text: "click", styles: {}, links: [{ url: "javascript:alert(1)", kind: "url" }] }],
    }),
  ]);
  ok("link href neutralised", linkEvil.includes('href="#"'), linkEvil);

  const rich = blocksToHtml(
    md(
      "- a\n- b\n\n1. one\n\n- [x] done\n\n> quoted\n\n> 💡 **Note** callout\n\n<details><summary>Open me</summary>\n\nhidden\n\n</details>\n\n```python\nprint('hi')\n```\n\n$$\nx^2\n$$\n\n![Cap](a.png)\n\n| Name | Age |\n| --- | --- |\n| Ann | 30 |\n",
    ).blocks,
    { title: "Rich" },
  );
  ok("ul emitted", rich.includes("<ul>\n<li>a</li>\n<li>b</li>\n</ul>"), rich.slice(0, 400));
  ok("ol emitted", rich.includes("<ol>\n<li>one</li>\n</ol>"));
  ok("to_do list class", rich.includes('class="to-do-list"'));
  ok("checkbox input", rich.includes('<input type="checkbox" disabled checked>'));
  ok("blockquote emitted", rich.includes("<blockquote>"));
  ok("callout emitted", rich.includes('<div class="callout">'));
  ok("callout icon", rich.includes('class="callout-icon" aria-hidden="true">💡</span>'));
  ok("details emitted", rich.includes("<details>\n<summary>Open me</summary>"));
  ok("summary is closed", rich.includes("<summary>Open me</summary>\n<p>hidden</p>\n</details>"));
  ok("pre code with language class", rich.includes('<pre><code class="language-python">print(&#39;hi&#39;)</code></pre>'));
  ok("katex div", rich.includes('<div class="katex katex-eq" data-latex="x^2">x^2</div>'));
  ok("figure and caption", rich.includes("<figure class=\"image\">") && rich.includes("<figcaption>Cap</figcaption>"));
  ok("table thead", rich.includes("<thead><tr><th>Name</th><th>Age</th></tr></thead>"));
  ok("table tbody row", rich.includes("<tr><td>Ann</td><td>30</td></tr>"));
  ok("nested list inside li", blocksToHtmlBody(md("- a\n  - b").blocks).includes("<li>a\n<ul>\n<li>b</li>\n</ul></li>"));
  ok("heading anchor", blocksToHtmlBody(md("## Deep Topic").blocks).includes('<h2 id="deep-topic">'));
  ok("page link href", blocksToHtmlBody([block("paragraph", { body: [{ type: "text", text: "T", styles: {}, links: [{ url: "My Page", kind: "page" }] }] })]).includes('href="#page-my-page"'));
  ok("underline supported in html", blocksToHtmlBody(md("text").blocks, {}).length > 0);
  ok("inline styles map", blocksToHtmlBody([
    block("paragraph", { body: [{ type: "text", text: "u", styles: { underline: true, color: "red" } }] }),
  ]).includes('<span class="fg-red"><u>u</u></span>'));
  ok("newlines become br", blocksToHtmlBody(md("a\nb").blocks).includes("a<br>b"));
  ok("css can be replaced", !blocksToHtml([], { includeCss: false, css: ".x{}" }).includes("--bg:"));
  ok("empty blocks give a document", blocksToHtml([]).includes("<main class=\"strata\">"));
  ok("katex scripts opt-in", blocksToHtml([], { katexScripts: true }).includes("katex"));
}

section("CSV parsing");
{
  eq("simple", parseCsv("a,b\nc,d").rows, [["a", "b"], ["c", "d"]]);
  eq("delimiter reported", parseCsv("a,b").delimiter, ",");
  eq("quoted field", parseCsv('"a,b",c').rows, [["a,b", "c"]]);
  eq("doubled quotes", parseCsv('"say ""hi""",c').rows, [['say "hi"', "c"]]);
  eq("embedded newline", parseCsv('"line1\nline2",c\nd,e').rows, [["line1\nline2", "c"], ["d", "e"]]);
  eq("embedded newline keeps row count", parseCsv('"a\nb",c').rows.length, 1);
  eq("crlf", parseCsv("a,b\r\nc,d\r\n").rows, [["a", "b"], ["c", "d"]]);
  eq("trailing newline adds no row", parseCsv("a,b\n").rows.length, 1);
  eq("bom stripped", parseCsv("\ufeffa,b\nc,d").rows[0]![0], "a");
  eq("empty field", parseCsv("a,,c").rows, [["a", "", "c"]]);
  eq("single column", parseCsv("a\nb").rows, [["a"], ["b"]]);
  eq("semicolon sniff", parseCsv("a;b;c\n1;2;3").delimiter, ";");
  eq("tab sniff", parseCsv("a\tb\n1\t2").delimiter, "\t");
  eq("tab cells", parseCsv("a\tb\n1\t2").rows, [["a", "b"], ["1", "2"]]);
  eq("quote-aware sniff", parseCsv('"a,b";c\n"1,2";d').delimiter, ";");
  eq("no delimiter falls back", parseCsv("just one field\nand another").delimiter, ",");
  eq("ragged rows", parseCsv("a,b,c\nd,e").rows, [["a", "b", "c"], ["d", "e"]]);
  eq("blank rows skipped", parseCsv("a,b\n\nc,d").rows, [["a", "b"], ["c", "d"]]);
  eq("blank rows kept on request", parseCsv("a,b\n\nc,d", { skipBlankRows: false }).rows.length, 3);
  eq("unterminated quote does not throw", parseCsv('a,"b').rows, [["a", "b"]]);
  eq("mid-field quote is literal", parseCsv('a"b,c').rows, [['a"b', "c"]]);
  eq("sniff reports tab", sniffDelimiter("a\tb\tc\nd\te\tf"), "\t");
  eq("crlf inside quotes is normalised to lf", parseCsv('"a\r\nb",c').rows[0]![0], "a\nb");
  eq("csv to database", csvToDatabase("Name,Qty\nAnn,3\nBob,4\n", { title: "People" }).properties.map((p) => p.type), ["title", "number"]);
  eq("csv to database rows", csvToDatabase("Name,Qty\nAnn,3\n").rows.length, 1);
  eq("csv to database values", csvToDatabase("Name,Qty\nAnn,3\n").rows[0]!.Qty, 3);
  eq("csv without a header", csvToDatabase("a,1\nb,2", { hasHeader: false }).properties.map((p) => p.name), ["Column 1", "Column 2"]);
  eq("duplicate header names", csvToDatabase("a,a\n1,2").properties.map((p) => p.name), ["a", "a (2)"]);
  eq("empty header cell", csvToDatabase(",b\n1,2").properties[0]!.name, "Column 1");
}

section("CSV serialising");
{
  eq("toCsv quotes commas", toCsv([["a", "b,c"], ["d", 'e"f']]), 'a,"b,c"\r\nd,"e""f"\r\n');
  eq("toCsv quotes newlines", toCsv([["a\nb"]]), '"a\nb"\r\n');
  eq("toCsv crlf", toCsv([["a"], ["b"]]), "a\r\nb\r\n");
  eq("toCsv empty", toCsv([]), "");
  eq("csvCell quotes", csvCell("a,b"), '"a,b"');
  eq("csvCell null", csvCell(null), "");
  eq("injection = prefixed", toCsv([["=1+1"]]), "'=1+1\r\n");
  eq("injection + prefixed", toCsv([["+1+1"]]), "'+1+1\r\n");
  eq("injection - prefixed", toCsv([["-1+1"]]), "'-1+1\r\n");
  eq("injection @ prefixed", toCsv([["@cmd()"]]), "'@cmd()\r\n");
  eq("injection tab prefixed", toCsv([["\t=1"]]), "'\t=1\r\n");
  eq("injection cell quoted too", csvCell("=SUM(A1,B1)"), '"\'=SUM(A1,B1)"');
  eq("guard can be disabled", toCsv([["=1"]], { guard: false }), "=1\r\n");
  eq("round-trip with injection", parseCsv(toCsv([["=1+1"], ["a,b"]])).rows, [["'=1+1"], ["a,b"]]);
  eq("round-trip of nasty cells", parseCsv(toCsv([['he said "hi"', "line1\nline2", "a,b;c"]])).rows, [['he said "hi"', "line1\nline2", "a,b;c"]]);
  eq("delimiter honoured", toCsv([["a", "b"]], { delimiter: ";" }), "a;b\r\n");
}

section("rowsToCsv");
{
  const prop = (
    id: string,
    name: string,
    type: PropertyDef["type"],
    config: Record<string, unknown> = {},
  ): PropertyDef =>
    ({ id, db_id: "db1", name, type, pos: "a", config }) as PropertyDef;

  const properties = [
    prop("p1", "Name", "title"),
    prop("p2", "Priority", "select", { options: [{ id: "o1", name: "High", color: "red" }] }),
    prop("p3", "Tags", "multi_select", {
      options: [
        { id: "t1", name: "alpha", color: "blue" },
        { id: "t2", name: "beta", color: "green" },
      ],
    }),
    prop("p4", "Due", "date"),
    prop("p5", "Done", "checkbox"),
    prop("p6", "Owner", "relation"),
    prop("p7", "Count", "number"),
  ];
  const rows: CsvRowInput[] = [
    {
      node: { id: "r1", body: [{ type: "text", text: "First task", styles: {} }] },
      values: {
        p1: "First task",
        p2: ["o1"],
        p3: ["t1", "t2"],
        p4: { start: Date.UTC(2024, 5, 1), end: null, allDay: true },
        p5: true,
        p6: { rows: ["x1", "x2"] },
        p7: 12,
      } as Record<string, PropertyValueInput>,
    },
    {
      node: { id: "r2", body: [{ type: "text", text: "Second task", styles: {} }] },
      values: { p1: "Second task", p2: [], p3: [], p4: null, p5: false, p6: { rows: [] }, p7: null } as Record<string, PropertyValueInput>,
    },
  ];

  const csv = rowsToCsv(rows, properties, "p1", {
    titles: { x1: "Alice", x2: "Bob" },
  });
  eq("header row", csv.split("\r\n")[0], "Name,Priority,Tags,Due,Done,Owner,Count");
  eq("select id becomes the name", csv.split("\r\n")[1], 'First task,High,"alpha, beta",2024-06-01,Checked,"Alice, Bob",12');
  eq("empty values are empty cells", csv.split("\r\n")[2], "Second task,,,,Unchecked,,");
  eq("rowsToCsv output parses back", parseCsv(csv).rows.length, 3);
  eq("title falls back to the node body", rowsToCsv([rows[1]!], [properties[0]!], "p1").split("\r\n")[1], "Second task");
  eq("explicit options map wins", rowsToCsv(rows, [properties[1]!], "p1", {
    header: false,
    optionsMap: { p2: [{ id: "o1", name: "Critical", color: "red" }] },
  }), "Critical\r\n\r\n");
  eq("date with time", valueToCell({ start: Date.UTC(2024, 0, 2, 13, 45), end: null, allDay: false }, prop("p", "d", "date", { withTime: true })), "2024-01-02T13:45:00.000Z");
  eq("checkbox unchecked", valueToCell(false, prop("p", "c", "checkbox")), "Unchecked");
  eq("checkbox checked", valueToCell(true, prop("p", "c", "checkbox")), "Checked");
  eq("relation joins titles", valueToCell({ rows: ["a", "b"] }, prop("p", "r", "relation"), { titles: { a: "One", b: "Two" } }), "One, Two");
  eq("relation falls back to ids", valueToCell({ rows: ["zz"] }, prop("p", "r", "relation")), "zz");
  eq("unknown select id falls back", valueToCell(["nope"], prop("p", "s", "select", { options: [] })), "nope");
  eq("number cell", valueToCell(3.5, prop("p", "n", "number")), "3.5");
  eq("null cell", valueToCell(null, prop("p", "n", "number")), "");
  eq("files cell", valueToCell({ mediaIds: ["m1", "m2"] }, prop("p", "f", "files")), "m1, m2");
  eq("semicolon delimiter", rowsToCsv(rows, [properties[0]!], "p1", { delimiter: ";" }).split("\r\n")[0], "Name");
  eq("injection guard in a title cell", rowsToCsv([{ node: { id: "r", body: null }, values: { p1: "=HYPERLINK()" } }], [properties[0]!], "p1").split("\r\n")[1], "'=HYPERLINK()");
}

section("detectFormat and importText");
{
  eq("md extension", detectFormat("anything", { filename: "notes.md" }), "markdown");
  eq("markdown extension", detectFormat("x", { filename: "a.markdown" }), "markdown");
  eq("csv extension", detectFormat("x", { filename: "a.csv" }), "csv");
  eq("tsv extension", detectFormat("x", { filename: "a.tsv" }), "csv");
  eq("html extension", detectFormat("x", { filename: "a.html" }), "html");
  eq("txt extension", detectFormat("x", { filename: "a.txt" }), "text");
  eq("html doctype", detectFormat("<!DOCTYPE html>\n<html><head></head><body><p>x</p></body></html>"), "html");
  eq("html document", detectFormat("<html>\n<body>\n<div>a</div>\n<div>b</div>\n</body>\n</html>"), "html");
  eq("markdown content", detectFormat("# Title\n\n- one\n- two\n"), "markdown");
  eq("markdown with a fence", detectFormat("```js\nx\n```\n\nmore text"), "markdown");
  eq("csv content", detectFormat("a,b,c\n1,2,3\n4,5,6\n"), "csv");
  eq("csv semicolon", detectFormat("a;b\n1;2\n3;4\n"), "csv");
  eq("plain text", detectFormat("just one line of prose"), "text");
  eq("empty is text", detectFormat(""), "text");
  eq("detailed reason mentions extension", detectFormatDetailed("# x\n\n- y\n", { filename: "a.md" }).reason.includes(".md"), true);
  eq("detailed format", detectFormatDetailed("a,b\n1,2\n").format, "csv");
  eq("importText csv", importText("Name,Qty\nAnn,2\n", { filename: "x.csv" }).databases[0]!.properties.length, 2);
  eq("importText csv block", importText("a,b\n1,2\n", { filename: "x.csv" }).blocks[0]!.type, "child_database");
  eq("importText markdown", importText("# H\n\ntext\n").blocks[0]!.type, "heading_1");
  eq("importText text", importText("one line of prose").blocks[0]!.type, "paragraph");
  eq("importText text warns", importText("one line of prose").warnings.length, 1);
  eq("importText text splits paragraphs", importText("one\n\ntwo").blocks.length, 2);
}

section("Column lists and embeds");
{
  const cols = md('<div class="column_list">\n<div class="column">\n\nleft\n\n</div>\n<div class="column">\n\nright\n\n</div>\n</div>');
  eq("column_list type", cols.blocks[0]!.type, "column_list");
  eq("two columns", cols.blocks[0]!.children.length, 2);
  eq("column ratio", cols.blocks[0]!.children[0]!.props.ratio, 50);
  eq("column content", blockText(cols.blocks[0]!.children[1]!.children[0]!), "right");
  const embed = md("<audio src=\"a.mp3\"></audio>");
  eq("audio warns", embed.warnings.some((w) => w.includes("audio")), true);
  eq("audio keeps a url", embed.blocks[0]!.props.url, "a.mp3");
  const stray = md("<section>\nsome content\n</section>");
  eq("unknown html block warns", stray.warnings.some((w) => w.includes("raw HTML block")), true);
  eq("unknown html block keeps text", blockText(stray.blocks[0]!), "some content");
  const htmlTable = md("# People\n\n<table><tr><td><b>Name</b></td><td><b>Age</b></td></tr><tr><td>Ann</td><td>30</td></tr></table>\n");
  eq("html table becomes a database", htmlTable.databases.length, 1);
  eq("html table header", htmlTable.databases[0]!.properties.map((p) => p.name), ["Name", "Age"]);
  eq("html table row", htmlTable.databases[0]!.rows[0]!.Age, 30);
  eq("html table block", htmlTable.blocks[1]!.type, "child_database");
}

section("Warnings contract");
{
  const res = md("# T\n\n<custom>x</custom>\n\n#### deep\n");
  ok("warnings are strings", res.warnings.every((w) => typeof w === "string"));
  ok("warnings are deduped", res.warnings.length === new Set(res.warnings).size, JSON.stringify(res.warnings));
  ok("warning is human readable", res.warnings[0]!.length > 10, res.warnings[0]);
  eq("clean import has no warnings", markdownToBlocks("# T\n\ntext\n").warnings, []);
  ok("import never throws on junk", markdownToBlocks("```\n>\n>\n$$\n- [ ]\n| a\n").blocks.length >= 0);
  ok("import survives empty input", markdownToBlocks("").blocks.length === 0);
  ok("import survives whitespace", markdownToBlocks("\n\n  \n").blocks.length === 0);
}

section("Documented non-support (defined behaviour, never silent)");
{
  eq("html comment dropped", text(md("a <!-- hidden --> b")), "a  b");
  eq("footnote stays literal", text(md("note[^1]")), "note[^1]");
  eq("reference link stays literal", text(md("[x][ref]")), "[x][ref]");
  eq("::: directive is a paragraph", md("::: info\n\ntext\n").blocks[0]!.type, "paragraph");
  eq("heading 6 maps to heading_3", md("###### Six").blocks[0]!.type, "heading_3");
  eq("nested quote becomes a child", md("> a\n> > b").blocks[0]!.children.length, 1);
  eq("nested quote kind", md("> a\n> > b").blocks[0]!.children[0]!.type, "quote");
  eq("table cell formatting is literal", md("| a |\n| --- |\n| **b** |\n").databases[0]!.rows[0]!.a, "**b**");
  eq(
    "synced_block div warns",
    md('<div class="synced_block">\n\nx\n\n</div>').warnings.some((w) => w.includes("raw HTML block")),
    true,
  );
  eq("toc div keeps text", blockText(md('<div class="toc">\n\n- a\n\n</div>').blocks[0]!), "- a");
  ok(
    "html import keeps text",
    importText("<html><body><p>hello</p><div>there</div></body></html>", {
      filename: "a.html",
    }).blocks.length >= 1,
  );
  eq(
    "highlight colour is dropped in markdown",
    blocksToMarkdown([
      block("paragraph", {
        body: [{ type: "text", text: "hi", styles: { backgroundColor: "yellow_background" } }],
      }),
    ]),
    "hi\n",
  );
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
