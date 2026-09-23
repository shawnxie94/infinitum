// 将品牌字体按 unicode-range 切成 woff2 分片，浏览器只下载当前页面实际用到的分片。
// 输入 assets/fonts/LXGWWenKaiMono.ttf（源文件不进打包产物）。
// 输出：分片 public/fonts/lxgw-wenkai-mono/（内容哈希文件名，immutable）；
//       样式表 public/fonts/lxgw/index.css（无哈希，max-age=3600，layout.tsx 以 <link> 引用）。
import { fontSplit } from "cn-font-split";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const inputFile = path.join(root, "assets/fonts/LXGWWenKaiMono.ttf");
const outDir = path.join(root, "public/fonts/lxgw-wenkai-mono");
const cssDir = path.join(root, "public/fonts/lxgw");
const publicUrlBase = "/fonts/lxgw-wenkai-mono";
const fontFamily = "LXGW WenKai Mono";

await rm(outDir, { recursive: true, force: true });
await rm(cssDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(cssDir, { recursive: true });

await fontSplit({
  input: inputFile,
  outDir,
  targetType: "woff2",
  // 200KB 分片在「单页命中请求数」与「@font-face 规则数（打进应用 CSS 的体积）」之间取平衡。
  chunkSize: 200 * 1024,
  css: { fontFamily },
  previewImage: false,
  reporter: false,
  testHtml: false,
});

const cssFileName = (await readdir(outDir)).find((name) => name.endsWith(".css"));
if (!cssFileName) {
  throw new Error("cn-font-split 未生成 CSS");
}

let css = await readFile(path.join(outDir, cssFileName), "utf8");
// 分片与 CSS 分居 public 与 src，相对 url 必须改写为 public 绝对路径。
css = css.replaceAll(/url\((["']?)\.\/([^)"']+)\1\)/g, `url($1${publicUrlBase}/$2$1)`);
// 源字体是 Medium（weight 500），但站内 --font-brand 一贯按 400 声明；去掉 local() 查找保证所有访客渲染一致。
css = css.replaceAll(/src:\s*local\([^)]*\)\s*,\s*/g, "src:");
css = css.replaceAll(/font-weight:\s*\d+/g, "font-weight:400");
if (!/font-display\s*:/i.test(css)) {
  css = css.replaceAll(/(@font-face\s*\{)/g, "$1\n  font-display: swap;");
}
await writeFile(path.join(cssDir, "index.css"), css, "utf8");
// 对外只有分片有用，分片目录里的生成副产品清掉。
await rm(path.join(outDir, cssFileName), { force: true });
await rm(path.join(outDir, "index.proto"), { force: true });
await rm(path.join(outDir, "preview.svg"), { force: true });

const chunks = (await readdir(outDir)).filter((name) => name.endsWith(".woff2"));
console.log(`subset done: ${chunks.length} chunks, css -> public/fonts/lxgw/index.css, family "${fontFamily}"`);
process.exit(0);
