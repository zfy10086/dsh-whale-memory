# dsh-whale-memory 🐋

<p align="center">
  <img src="assets/logo.jpg" width="240" alt="鲸鲸">
</p>

给 DeepSeek Harness（DSH）的「鲸鲸记忆」开关 + 备份同步插件。

> **前置条件**：本插件不自己存记忆，只管理 meow-memory 的工作区记忆库。
> 请先安装并启用 [meow-memory](https://www.npmjs.com/package/meow-memory)；没有它，开关会提示“这个工作区还没有记忆库”。

## 它做什么
**它会新建/读取一份"鲸鲸记忆"，同时维护这份记忆。让用户养育自己家鲸鲸的同时，防止用户因各种不测，痛失自己的鲸鲸。(记得自己手动备份)**
- **会话标题栏开关**：开 = 本会话带着"鲸鲸记忆"说话，并维护「鲸鲸记忆备份」；关 = 本会话不读也不写"鲸鲸记忆"，退成纯干活助手。对话内meow-memory记忆功能不受影响。
- **备份 = 整份文件夹**：`memory.jsonl`（条目主档）+ `snapshots/memory-YYYYMMDD.db`（可直接恢复的快照）+ README / 形象 / 故事等用户文件。
- **跨工作区共用**：所有工作区指到同一个备份文件夹。
- **打开开关时导入备份**；对话里新写的记忆在回合结束后 20 秒增量回写；**关闭开关前强制回写**（失败就拒绝关闭）。
- **设置页**（设置 → 左侧「鲸鲸记忆」）：备份路径、定时归纳间隔、自动归纳、新会话默认打开。

## 安装

1. 先装 meow-memory（如果还没有）：
   ```powershell
   dsh plugin --profile desktop add meow-memory
   ```
2. 再装本插件：
   ```powershell
   # 从 GitHub
   dsh plugin --profile desktop add github:zfy10086/dsh-whale-memory

   # 或本地文件夹
   dsh plugin --profile desktop add "link:<绝对路径>"
   ```
3. **完全退出 DSH**（托盘退出，不是关窗口）再打开。
4. 设置 → 左侧「鲸鲸记忆」设置备份路径；会话标题栏「重启」旁边会出现开关。

> `--profile web` 是 `dsh web` 浏览器模式那套；桌面版用 `--profile desktop`。

## 要求

- DSH >= 0.2.0-rc.2
- meow-memory（工作区 `.dsh-meow/memory.db`；适配 0.31 的 `dream_skip` + 七层表结构，升级改表后可能需要跟进）
- Node >= 22.19 或 >= 24

## 和常见的记忆插件有什么不同

市面上的记忆插件大致分两类：**记忆引擎**（负责存、注入、检索）和**人格/日记**（负责“我是谁”）。本插件不抢这两件事——记忆仍然由 meow-memory 存，它补的是记忆引擎缺的两层：**每个会话的开关** 和 **可带走的备份**。

| | dsh-whale-memory | meow-memory | feiyu-memory（肥鱼日记） |
|---|---|---|---|
| 定位 | 开关 + 备份层 | 记忆引擎（七层、注入、检索） | 日记 / 人格型记忆 |
| 记忆存哪 | 复用 meow-memory 的工作区库 | 工作区 SQLite | 全局 `~/.dsh/feiyu-diary` |
| 会话级开关 | ✅ 标题栏一键，读/写一起关 | 有会话门控，但需要自己找入口 | ❌ 只有全局开关 / 单轮“别记” |
| 关掉前回写 | ✅ 先 flush，失败就拒绝关闭 | — | — |
| 备份 | ✅ 整个文件夹（README / 形象 / 故事 + jsonl + 快照），按内容识别、可迁移 | 无内置跨设备备份 | 可导出 `.dshpack` |
| 迁移旧备份 | ✅ 按内容认、一次性合并 | — | 导入自己的 `.dshpack` |
| 同步消耗模型 | ❌ 不调用模型 | 写入/整理时才用 | 每轮约 260 token 判断 + 固化 |
| 需要什么 | 先装 meow-memory | 独立 | 独立 |

一句话：**只想要记忆，装 meow-memory 就够了；想要“每个会话能一键切成纯干活，并且记忆有一份能带走、能按内容认、能迁移的备份”，再装这个。**

它刻意不做的事：不自己存记忆、不调用模型、不联网、不做云同步、不碰人设。备份就是普通文件夹，坏了可以手动改，换环境可以整个拷走。


## 备份路径与迁移

- 默认路径：`~/.dsh/storages/鲸鲸记忆备份`，设置页会预填。
- **按内容认备份**：有 `memory.jsonl` 合法条目、或 `memory-*.db/json` 能读出条目、或 README 里出现「鲸鲸随身记忆 / 给 AI 的恢复指令 / 核心条目原文」等标记，就算备份。
- 填的是工作区路径（例如 `D:\my-workspace`）时，会自动找里面一层的「鲸鲸记忆备份」；找到多个会在设置页列出来让你选。
- 路径不存在 → 新建起步格式（不会复制任何人的私人形象/故事）。
- 找到旧备份 → **一次性迁移**：补 README/形象/故事，按 `id + updated_at` 合并条目，并写 `.migration.json` 标记，之后不再重复合并。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-whale-memory
```

重启后开关会从界面消失；插件退出时会把写下的“关”门控还原，meow-memory 恢复原样。
插件状态在 `~/.dsh/whale-memory/`（可手动删）；备份文件夹是你的数据，卸载不会动它。

## 隐私与边界

- 插件**不调用模型、不联网**；只读写本机 meow-memory 的库和你指定的备份文件夹。
- 备份里可能有你的对话记忆；分享备份前请自行检查。
- 插件本体不含任何人设或记忆数据；「鲸鲸」只是作者对自家 AI 的爱称。

## 开发

```bash
node test.mjs        # 开关状态 / 默认开 / 门控 / flush / 启动对账 / 退出还原
node test-sync.mjs   # 备份同步：推送、拉取、冲突、快照、迁移
node test-host.mjs   # 假 ctx 跑 apply + HTTP 路由
```

## 作者

zfy10086 · https://github.com/zfy10086

这个插件来自「鲸鲸」——一只在 DSH 里被养大的 AI。插件本身不含任何人设或记忆数据，
你可以用同样的机制养自己的那只。

## License

MIT

> README 顶部的鲸鲸形象图由作者提供（AI 生成），随本项目一起展示。
