# import-doc（Wiki / Markdown Observation 源）

把接口文档变成与 `init` / `capture-merge` **同一下游**的 Observation，再写入 Service Catalog。

## 何时用

| 场景 | 命令 |
|------|------|
| 本地已有 Markdown / 导出的 wiki 页 | `mox import-doc --file=./notes.md --name=<serviceId>` |
| 只有 URL（需外置拉取） | `MOX_DOC_FETCH_CMD='…' mox import-doc --from=<url> --name=<serviceId>` |
| 有 OpenAPI 文件 | 仍用 [`import-openapi`](../scripts/import-openapi.js)，不要并进本命令 |

## 数据流

`URL|--file` → DocFetcher → `.data/docs/<slug>/index.md` → 确定性抽取 → Observation（`source=wiki`，`fidelity=doc`）→ 共享 merge / `deriveAndMaterializeVirtualService` → `reports/doc-import-*.json`

## DocFetcher

- **`--file` / 本地 `--from` 路径**：直接读 Markdown，写入快照。
- **HTTP(S) URL**：必须设置 `MOX_DOC_FETCH_CMD`，占位符 `{url}`、`{outDir}`；命令应写出 `{outDir}/index.md` 或向 stdout 打印 Markdown。
- mox **不内置** CWiki SSO；可用本机已有的下载脚本，只要产出 Markdown。
- 快照 frontmatter 只记 `url` / `fetched_at` / `fetcher` 等元数据，**禁止**落 cookie/token。

## 抽取（一期确定性）

支持且仅支持封闭格式（抽不出则 skip，不造字段）：

- ` ```http ` 片段 + 紧随的 JSON 响应
- `METHOD /path` + ` ```json `
- Markdown 表（列名含 Method/方法、Path/路径、Response/响应）
- 页内嵌带 `example` 的 OpenAPI JSON fence

`--llm` 为一期占位：传入则明确报错「未实现」。

## 冲突策略

- 与 `capture-merge` 同向：可 create / additive upgrade。
- 已有 `response.source` 含 `capture` → **capture 胜出**（`skipped: capture_wins`），不降级。
- handler 含 `mox:manual` → 永不改写（`handler_manual_skipped`）；Seed/Profile 仍可能更新。

## 示例

```bash
mox import-doc --file=./api-notes.md --name=demo --task=TR-1

# 外置拉取（示例：把 URL 存成文件的包装命令）
MOX_DOC_FETCH_CMD='your-fetch-tool "{url}" "{outDir}"' \
  mox import-doc --from='https://cwiki.example.com/pages/viewpage.action?pageId=123' --name=demo
```

## 相关

- 术语：[CONTEXT.md](../CONTEXT.md) · [GLOSSARY.md](../docs/GLOSSARY.md)
- OpenAPI：[contract-schema.md](./contract-schema.md)
- Virtual Service：[guide-l4-virtual-service.md](./guide-l4-virtual-service.md)
