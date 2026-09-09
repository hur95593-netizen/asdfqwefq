# 输出契约

## 目录与读者

```text
<新输出目录>/
├── requirements.md          交给前端的需求正文，仅 included 范围
├── mock-data.md             纳入范围的 mock 参考、来源与完整快照链接
├── inventory.json          脚本生成的原始发现清单
├── audit.json              agent 生成的证据、范围与覆盖台账（内部）
├── verification.json       validate_output.py 生成的机器检查报告
├── review.md               独立语义复核、并行执行摘要、真实缺口（内部）
├── mock-data/
│   ├── raw/<原相对路径>    原始候选源文件，逐字节备份
│   ├── snippets/           可选的精确字节片段，必须能与 raw 对应区间比对
│   └── normalized/         可选的纯数据派生 JSON，不替代原始文件
└── evidence/               有运行观察时保存截图/日志；不要放空占位文件
```

`parts/` 可供 subagent 分片写入，整合后可保留在内部审计区。原始源文件可能同时含多个模块，允许原样备份；需求正文与 mock 参考只能解释 included 的部分。excluded/pending 数据不丢弃，定位留在 audit.json。混有 excluded/pending 内容的完整 raw 仅在内部 audit 引用，公开参考改为仅含 included 数据的精确片段或派生文件；纯 included 原件可以直接链接。

## 正文规范

使用 [需求模板](../assets/requirements.template.md) 的内容组织方式；删掉所有提示语。每项确定需求使用唯一三级标题 `### REQ-001 标题`，便于机器核对。REQ 标题集合必须与 audit.requirements 的 ID 集合一致，正文不得自行补出没有台账的需求。禁止把设计建议伪装成确定需求。

每条需求包含：所属 PAGE、模块职责（included）、触发/前提、输入与规则、状态变化与反馈、已知边界、可执行验收、EV 证据和需要时的 MOCK 引用。UI 细节与业务规则分别表达，后端未知接口只写待确认。共享需求可关联多页，但页面特有差异必须单独写清。

正文不列“复用 xxx 模块”的排除清单，也不为它生成组件结构、字段、API、测试或“将来实现”条目。确有证据的新增宿主集成归宿主模块，不展开复用模块内部。只有经消歧、足够独特的复用名称才作为 `forbidden_terms` 参与文本扫描；同名普通词依靠独立语义复核，不用粗暴全局删词。

`mock-data.md` 每条 included mock 使用 `### MOCK-001 名称`，列出用途、来源路径及行/字节范围、hash、数据类型、是否派生、样例覆盖状态。纯 included 原件给出原始快照链接；混合原件只公开 included 精确片段/派生文件的链接，完整 raw 定位留内部 audit。可展示少量样例并明确“样例，完整数据见备份”；共享源文件注明公开附件的实际范围，不能把部分提取说成整文件。无法可靠分离时保留 raw，在公开参考说明该纳入样本尚不能独立恢复，不链接排除范围内容。独立 JSON 的完整记录数可以统计；运行总数、分页 total 和演示数组长度不得混淆。没有 included mock 时写“本次纳入范围未发现需要引用的 mock 数据”，保留已检查的范围依据。

本地 Markdown 文件链接用相对输出目录路径，面向对话交付时用实际绝对路径链接；正文源证据用 `相对源路径:起止行` 或 EV 编号，避免制造不存在的链接。

## inventory.json：脚本事实

`inventory_demo.py` 的 schema_version 为 1。重要字段：

- `source_root`：原始输入绝对路径。
- `files[]`：`id, path, sha256, size, roles, line_count, encoding`；path 是源目录相对路径，line_count 用于校验来源行号上界。
- `entry_candidates[]`：`id, file_id` 及脚本发现信息，候选不是最终页面。
- `document_candidates[]`：`file_id` 及发现信息；所有自有 md/txt/html 均需判读。
- `mock_candidates[]`：`id, source_file, path, reason, line_start, line_end, snapshot, sha256`。
- `exclusions[]`、`warnings[]`：跳过项与实际读取/分析缺口，不应被当作“无业务内容”。`limitations[]` 是候选启发式等一般能力边界，不单独制造 incomplete。

不要人工重写原始盘点来掩盖遗漏。漏掉的源码快照用 `--include-source` 在新输出目录重新生成清单；合并旧分析时按 path+hash 重新映射 file_id，不能假定排序 ID 不变。

## audit.json：统一结构

UTF-8 JSON，`schema_version: 1`。下列数组必须存在，可以为空；引用使用 ID。ID 在各自数组内唯一。`evidence` 引用数组在需要判断依据的记录中不得为空。字段允许附加，以保存更多定位信息。

| 数组 | 每项必需字段 | 意义/枚举 |
|---|---|---|
| `file_reviews` | `file_id, status, reason` | status = reviewed / not_applicable / deferred。覆盖 inventory.files 每项；not_applicable 说明为何与需求无关 |
| `entry_reviews` | `candidate_id, decision, page_ids, reason` | decision = page / document / asset / deferred。覆盖全部入口候选；page 至少关联一个页面。兼任说明在 documents 另记 |
| `documents` | `file_id, status, note_ids, reason` | status 同 file_reviews。覆盖全部说明候选；reviewed 但无条款时说明只含 UI/其它内容 |
| `notes` | `id, evidence, decision, targets` | 每条有产品含义的补充单独记录；decision = requirement / exclude / context / question。targets 指向 REQ / MOD / QUESTION；context 可空 |
| `pages` | `id, entry_file, locator, kind, status, evidence` | kind = html / route / state；status = verified / static_only / blocked。locator 是真实入口、路由模式或状态路径 |
| `modules` | `id, name, scope, evidence, reason` | scope = included / excluded / pending；同名异物独立 ID 与理由 |
| `evidence` | `id, file_id, line_start, line_end, kind, detail` | kind = source / document / runtime；行号正整数且 end ≥ start，detail 描述实际证据。runtime 额外必需 artifact（输出内真实截图/日志路径） |
| `requirements` | `id, title, module_id, page_ids, evidence, acceptance, mock_ids` | module 必须 included，page_ids/evidence/acceptance 非空；acceptance 为可验证的字符串数组 |
| `interactions` | `id, page_id, module_id, label, disposition, requirement_ids, evidence, reason` | 已发现控件/事件/状态分支的覆盖单元；disposition = requirement / excluded / not_applicable / pending |
| `mocks` | `id, module_id, source_file, snapshot, sha256, line_start, line_end` | 原始源文件快照，其 hash 应等于对应 inventoried source hash；可选 start_byte/end_byte（0-based 半开区间）及 normalized_path |
| `mock_reviews` | `candidate_id, decision, mock_ids, reason` | decision = backed_up / not_mock / pending，逐个覆盖 mock_candidates |
| `questions` | `id, detail, evidence, blocking` | 不确定结论、缺材料、冲突；blocking 布尔值，只影响实际所涉及的范围 |

另有必需对象 `execution`：`subagents_used`（非负整数）、`parallel_reason`（实际并行内容或顺序原因），记录真实执行，不填写计划数。可以补充 worker 分工与完成状态。`forbidden_terms` 为字符串数组，可为空，用于扫描两个公开 Markdown 中经确认不可出现的独特排除模块名称。被误判为普通词时先消歧，再调整此列表，不能以删掉禁词规避真实污染。

`interactions` 既包含已实现行为，也包含文档声明而 Demo 未实现的行为，以及可能影响验收的可观察状态分支。不可交互的装饰可 not_applicable 并解释。excluded 只能归 excluded module，pending 用于未决范围/含混行为；requirement 必须引用同模块的需求且需求应关联该 page。孤立模块如果未发现可交互行为，仍需证据说明其职责；不要为凑覆盖率伪造 interaction。

`notes` 的 requirement 至少指向一个 REQ；exclude 至少指向一个 excluded MOD；question 至少指向一个 QUESTION；context 可指相关实体。每个 note 必须出现在某个 documents.note_ids 中并以该文档为证据。混合条款先拆分再分别归档，不能用“已处理整份文档”代替逐条覆盖。

`mocks` 可指向 excluded / pending 模块以保留数据；公开参考只解释 included mock。保存精确原始片段时同时填 `snippet_path, snippet_sha256, start_byte, end_byte`，校验器检查片段 hash 且逐字节比较 `raw[start_byte:end_byte]`；经过转换的派生文件使用 `normalized_path`，不能冒充精确片段。`mock_reviews.backed_up` 至少指向一个同 source_file 的 MOCK，多个启发式候选可归并同一个 mock。每个 MOCK 必须至少被一个 backed_up review 引用。动态数据无法还原时仍备份生成器源码，说明不能恢复具体输出；若缺源文件或缺字节备份则 pending，不声称完整备份。

## 最小示例（展示结构，不能作为实际分析结果）

以下假设清单中已有一个 HTML 文件 F-0001、入口 EC-0001、一个 mock 候选 MC-0001；真实候选 ID 以脚本输出为准。示例 hash 和来源必须在实际运行时替换，不直接复制。

```json
{
  "schema_version": 1,
  "execution": {"subagents_used": 0, "parallel_reason": "仅一个小页面，说明与数据都在同一文件内"},
  "forbidden_terms": [],
  "file_reviews": [{"file_id": "F-0001", "status": "reviewed", "reason": "读取全部页面和脚本"}],
  "entry_reviews": [{"candidate_id": "EC-0001", "decision": "page", "page_ids": ["PAGE-001"], "reason": "独立 HTML 入口"}],
  "documents": [{"file_id": "F-0001", "status": "reviewed", "note_ids": [], "reason": "只有演示界面，没有补充条款"}],
  "notes": [],
  "pages": [{"id": "PAGE-001", "entry_file": "F-0001", "locator": "index.html", "kind": "html", "status": "static_only", "evidence": ["EV-001"]}],
  "modules": [{"id": "MOD-001", "name": "项目列表", "scope": "included", "evidence": ["EV-001"], "reason": "页面自有功能，无复用指令"}],
  "evidence": [{"id": "EV-001", "file_id": "F-0001", "line_start": 1, "line_end": 12, "kind": "source", "detail": "本地过滤列表及演示数据"}],
  "requirements": [{"id": "REQ-001", "title": "按名称过滤项目", "module_id": "MOD-001", "page_ids": ["PAGE-001"], "evidence": ["EV-001"], "acceptance": ["给定两条不同名称项目，输入其中一个名称后仅显示匹配项"], "mock_ids": ["MOCK-001"]}],
  "interactions": [{"id": "INT-001", "page_id": "PAGE-001", "module_id": "MOD-001", "label": "名称输入", "disposition": "requirement", "requirement_ids": ["REQ-001"], "evidence": ["EV-001"], "reason": "对应本地过滤事件"}],
  "mocks": [{"id": "MOCK-001", "module_id": "MOD-001", "source_file": "F-0001", "snapshot": "mock-data/raw/index.html", "sha256": "替换为原始文件实际SHA256", "line_start": 3, "line_end": 5}],
  "mock_reviews": [{"candidate_id": "MC-0001", "decision": "backed_up", "mock_ids": ["MOCK-001"], "reason": "脚本中硬编码项目数组，原始源文件已备份"}],
  "questions": []
}
```

若运行不可用，示例中的 static_only 将得到 `incomplete`，这是正确结果。不要改成 verified 来让检查通过。

## 校验报告

调用 `validate_output.py OUTPUT_DIR` 生成 verification.json（允许更新自己的报告）。报告含 `status, errors, gaps, coverage, limitations`；其它内容由 script 补充。CLI 退出码：0 = 机器检查通过且无已声明缺口；1 = 结构、关联、范围或备份错误；2 = 无硬错误但存在未完成/未运行/待确认项。没有语义审查的“机器通过”不能表述为需求完整。

coverage 至少分别统计：文件判读、入口裁定、说明候选判读、补充条款映射、已发现交互去向、mock 候选裁定，以及页面运行验证数。分母使用原始候选/已发现单元，不用输出的需求数当“总需求数”。excluded 和 not_applicable 可以是已裁定项，但必须独立报数；pending/deferred 不得计入完成。

机器能确认引用、文件和 hash；它不能证明没有未知路由、漏掉条款、错解复用、或错误验收。`review.md` 必须记录对照原始材料的审查范围、实际发现/修复、剩余限制、agent 分工，以及是否仍可宣称完整。
