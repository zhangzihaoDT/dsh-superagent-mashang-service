# Prepare 收尾验收（2026-11-03）

验收范围：SuperAgent Harness、Prepare、只读查询提示词和执行计时；没有修改 mashang-service 的业务代码、指标定义或数据更新流程。

## 正式验收

新 Ticket：`d675fa2f5288619780e45a74453583f7`。全部 19 项验收检查通过，最终 worker turn 已结束。

- LS9 上市以来累计锁单 **21,655**，其中用户车 **20,872**。
- 上市日为业务定义中的 2025-11-12；数据截止为 **2026-11-03 00:58:03**（`lock_time`）。使用既有上市监控口径及订单去重、测试单过滤规则。
- Prepare 从干净 checkout 创建 worktree；订单快照 551,347 行、40,070,930 字节，APFS clone、权限 `0444`，cutoff 在配置的 24 小时新鲜度范围内。
- 实际 worker 系统提示包含新的只读约束；Ticket API 暴露正确的 `DSH_SUPERAGENT_PREPARE_CLI` 和 `DSH_SUPERAGENT_PREPARE_RECORD`。
- 官方查询执行一次，无直接 parquet 重算、parquet 搜索、外部 `cd` 或重复脚本。查询使用 dry-run，输出在临时目录，无 PR 或对外回复。
- 数据命中业务仓库现有 `.gitignore` 第 6 行 `/dataset/*`；worktree 的完整 Git status 为空。SuperAgent 的 `.artifacts/` 也被忽略，审计文件和复制数据不会进入本次提交。
- Ticket 的临时 worktree、数据副本及分支已清理，源数据保留。

## 耗时对比

旧基线从 Ticket `ba5602e2b7025158c48854ea4cd4240f` 的原始 Session 首轮事件回算。新版读取最终 `turn/end` 后的 execution-timings，避免把报告时尚未结束的轮次当成最终计时。

| 指标 | 旧首轮 | 新首轮 |
| --- | ---: | ---: |
| Prepare 外部命令 | 未单独记录 | 1.131 s |
| Prepare helper 内部 | 未单独记录 | 1.021 s |
| Worker turn | 328.066 s | 142.819 s |
| 模型阶段 | 302.234 s | 138.389 s |
| 工具阶段 | 25.140 s | 4.186 s |
| 工具调用 | 54 | 18 |
| Prepare 开始至 turn 结束 | 未单独记录 | 144.032 s |

Worker 首轮耗时下降约 56%，工具调用下降约 67%。工具阶段包含查询脚本及其他工具耗时。模型阶段是 step 开始至 assistant message 的耗时，不等于纯解码时间。耗时仍受模型响应波动影响；本轮约 2.4 分钟，高于原先 1–2 分钟的参考目标，但该目标不是牺牲正确性的硬限制。

## 服务、兼容性和异常处置

上次重启成功。最终服务由 launchd 管理，PID 47296，未暂停；runtime、GitHub、飞书、history 及执行相关健康项均为 ready，无 setup problem。Ticket 列表、详情和执行链正常。本次使用无来源频道的合成 Ticket 验证真实 Executor/Prepare/Worker；GitHub 和飞书核验到监听及历史恢复健康，未额外发送外部消息测试。

发现并处理两类旧任务残留：

1. `local.dsh.superagent.acceptance` 的重复拉起导致多次服务重启；已移除该遗留 launchd 验收任务，停止其多余排队 Ticket。
2. 原 DSH 管理 Session 的一次性提醒恢复了旧任务，造成并发验收；已在界面停止该 Session 及其后台验收脚本，额外 Ticket 已结束、临时目录已清理。

受重启干扰的 Ticket `0d80095ed8e8bbbc2b95791c247d9d1a` 返回正确数字，但恢复过程中额外读取 parquet，因此未作为正常效率验收样本。没有修改提示词或业务代码来掩盖该结果。本 Codex 会话没有执行服务重启。

本地验收脚本原先错误检查 `ticket_id` 字段，并将读取脚本、`--help` 误计为正式查询执行；仅修正了被 Git 忽略的验收工具，保留原始失败记录。最终计时在 turn 结束后另行归档。

## 清理边界及验证

Prepare 失败会回滚新建的 worktree 和分支。成功 Ticket 的快照保留用于后续处理，**当前没有自动按时间清理机制**；本次验收显式清理临时 worktree 和分支，并保留审计记录。部署需要按保留策略清理已结束且 worker 空闲的 Ticket，参见 [Workspace preparation](011-workspace-prepare.md)。没有在本次收尾新增后台清理功能。

`pnpm check` 通过：类型检查、61 个测试文件 / 1,206 项测试，以及构建。`git diff --check` 通过。

本机原始证据保留在被 Git 忽略的 `.artifacts/acceptance/`：正式运行 `ls9-acceptance-20261103-133458.json`、`20261103-133458-final-timing.json`、Prepare 记录、`verified-old-baseline.json` 及受干扰运行的记录。正式 Ticket 的 Prepare 和 execution-timings 原件也保留在 state 目录。

## 查询契约优化复验（同日 14:28）

在不修改业务仓库的前提下，为 `officialQueries` 增加可选 `contract`：适用范围、参数来源、必读参考、JSON 结果文件/唯一选择/字段映射、校验和异常调查条件。Prepare 校验并完整传递声明，不解释表达式或执行模板；旧 profile 保持兼容。示例与本机部署 profile 使用既有 `vehicle_sales_monitor.py`，未引入 LS9 Job 或复制指标计算逻辑。Worker 提示词要求消费保存的 Result Contract，并复用成功 Prepare 的快照校验证据；通用提示词仍在原字符预算内。

第一次新样本 `f3c8ac9b92b0c68dc6e81a70801261e3` 的 Worker turn 为 46.513 秒，结果正确，但在所有结果检查通过后仍自行读取 parquet 复核快照，因此严格效率检查失败。保留失败记录，随后只明确了“成功 Prepare 的行数、checksum、cutoff、新鲜度不做例行重复核验”的边界；异常或矛盾仍需调查，没有删除校验或放宽验收条件。

最终新 Ticket `2918eeb18b85390f607cbad477fab5ee` 通过全部 19 项验收：**21,655 / 用户车 20,872**，相同数据截止，官方查询执行一次，无 parquet 搜索、原始数据重复读取、外部 cd 或重复脚本。读取保存的 JSON Contract；匹配 generation/phase，核对状态、warnings/errors、scope、上市日和数值关系。worktree、数据副本和分支已清理，审计原件保留。

| 指标 | 上一版正式样本 | 契约优化后正式样本 |
| --- | ---: | ---: |
| Prepare 外部命令 | 1.131 s | 1.177 s |
| Worker turn | 142.819 s | 48.863 s |
| 模型阶段 | 138.389 s | 45.812 s |
| 工具阶段 | 4.186 s | 2.852 s |
| 模型步骤 | 15 | 8 |
| 工具调用 | 18 | 12 |
| Prepare 开始至 turn 结束 | 144.032 s | 50.110 s |

Worker turn 缩短约 66%，工具调用减少约 33%；官方脚本对应工具调用耗时 2.425 秒。以上为单次真实样本，不能分离模型服务延迟波动与流程优化的全部影响，也不保证固定时延。仍有目录查看和分批参考读取，尚未把所有操作合为一次工具调用；本轮未继续扩展改造。

完整 `pnpm check` 通过（61 个文件 / 1,207 项测试、类型检查及构建）；最后的提示词边界修正又通过类型检查、model-surface/prepare 的 13 项相关测试及构建。最终 `git diff --check` 通过。两次激活均由独立 Codex 会话执行服务重启，没有 Worker 自重启；最终服务 PID 44434，GitHub、飞书和执行健康项全部 ready。

原始证据：`.artifacts/acceptance/ls9-acceptance-20261103-142444.json`（失败样本）及 `ls9-acceptance-20261103-142721.json`（最终样本，已等待 turn/end 再采集计时与清理）。
