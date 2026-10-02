# Cluster quality review 2026-10-02（round 2）

24 条全新 7 天盲样（local qualification snapshot，capture asOf 2026-10-02T11:41:35.000Z）：18 高相似 + 2 safety-rejected 相关 + 4 低相似覆盖对照（配额真实全满；strata 为弱偏置诊断，非总体率、非 gold labels）。流程见 `docs/eval/cluster-quality-sample.md`。

## 文件

- `packet/blind-review.csv`：盲审 CSV，用户已回填 24 条（23 diff / 1 same）；提交前备份见 `packet/blind-review.user-submitted.csv`。
- `packet/frozen-manifest.json` / `.sha256`：冻结 manifest 及 sidecar（`10fa0c8a69ea400d70e3e3e1c45f2a0dc9c1a9a3938f2b3a1554a165e36471d1`；trust anchor 为外部记录的 expected-manifest-sha）。
- `packet/readiness-report.json`：当前 assess 结论 `insufficient_truth`（dev 无正类样本，不足以判定质量，非 quality passed）；same_event 仅 holdout 1 条，属诊断信号。
- `sources/`：不可变来源（pending CSV + 私有采样 manifest，含 weakBm25Score / weakSafetyReason / 配额统计，仅采样偏置诊断）。其中 pending-review.csv 是捕获时的历史初始 pending 状态，非当前审阅进度。

说明：文件清单与 SHA 表中 blind-review.csv 的 hash 为冻结输入时刻的值；人工回填后 canonical CSV sha 已改变，属预期，输入保护以 frozen manifest 的 per-case checksum 为准。评测建设已暂停，资料保留，后续不自动补样本/调策略。

## 审阅约定

- 仅凭可见 pair 字段独立判断 same/diff/uncertain；来源与弱判定不作 gold。
- 复评 baseline 必须显式 `--as-of 2026-10-02T11:41:35.000Z`。
