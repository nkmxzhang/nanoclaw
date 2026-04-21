# Feishu × Claude Code Skill 设计文档

**日期**：2026-04-21  
**状态**：已批准，待实现  
**作者**：tapir

---

## 概述

为 Claude Code CLI 添加飞书双向通信能力，使 Claude Code 在执行复杂任务期间能通过飞书与用户交互：发送进度通知、等待确认、补充信息，用户也可从飞书主动发消息干预任务执行。

该 Skill 完全独立，不依赖 NanoClaw 或任何其他项目，安装后驻留在 `~/.claude/` 下。

---

## 背景与参考

- 借鉴 NanoClaw 的 `add-feishu` skill（`@larksuiteoapi/node-sdk` + WebSocket 长连接模式）
- 使用 Claude Code 的 MCP stdio 模式和 hooks 机制
- 飞书 SDK 已有成熟的消息收发和 WebSocket 事件分发实现

---

## 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 独立 vs 依赖 NanoClaw | 独立 | 用户不一定使用 NanoClaw |
| 等待模型 | 同步阻塞 + 可配置超时 | Claude Code 顺序执行，心智模型最简单 |
| 运行方式 | MCP stdio（Claude Code 管理生命周期）| 零守护进程管理，会话期间全程在线即满足需求 |
| 触发方式 | 混合：MCP 工具（Claude 主动）+ hooks（自动拦截）| 覆盖主动判断和自动安全拦截两种场景 |
| 路由 | 三个独立 target：notify / confirm / summary | 通知发群，确认发私聊，灵活可覆盖 |

---

## 支持的使用场景

| 场景 | 触发方式 | 是否阻塞 |
|------|---------|---------|
| A. 高风险操作确认（`rm -rf`、`git push --force` 等）| PreToolUse Hook 自动拦截 | ✅ 等飞书回复 |
| B. 任务执行中补充信息 | Claude 主动调用 `feishu_ask` | ✅ 等飞书回复 |
| C. 阶段性进度通知 | Claude 主动调用 `feishu_notify` | ❌ |
| D. 任务完成总结 | Stop Hook 自动触发 / Claude 主动调用 `feishu_summary` | ❌ |
| E. 用户从飞书主动发消息 | WebSocket 收件箱 + PreToolUse Hook 注入 | ❌ |

---

## 文件结构

### Skill 本体（分发位置）

```
~/.claude/skills/feishu-bridge/
├── SKILL.md                        ← 安装向导 + Claude 行为指南
├── setup.ts                        ← 交互式安装脚本（运行一次，不安装到 bridge）
└── bridge/                         ← 整体复制到 ~/.claude/feishu-bridge/
    ├── src/
    │   ├── index.ts               ← 入口：启动 MCP + HTTP + Feishu WS
    │   ├── feishu.ts             ← Feishu WebSocket 连接 & 发消息
    │   ├── mcp.ts                ← MCP 工具定义
    │   ├── http.ts               ← 本地 HTTP server（供 hooks 调用）
    │   ├── inbox.ts              ← 收件箱文件管理
    │   └── config.ts            ← 读取配置
    ├── scripts/
    │   ├── intercept-bash.sh    ← PreToolUse hook：高风险命令拦截
    │   ├── check-inbox.sh       ← PreToolUse hook：收件箱注入
    │   └── on-stop.sh           ← Stop hook：任务总结
    └── package.json
```

### 安装后产生（运行时位置）

```
~/.claude/
├── feishu-bridge/                 ← 编译后的可运行 bridge
│   ├── dist/
│   └── node_modules/
├── feishu-bridge.json             ← 用户配置
├── feishu-inbox/                  ← 用户从飞书主动发来的消息暂存
└── settings.json                  ← 追加 mcpServers + hooks + permissions
```

---

## 配置文件：`~/.claude/feishu-bridge.json`

```json
{
  "appId": "cli_xxxxxxxxxxxxxxxx",
  "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "httpPort": 7730,
  "timeout": 1800,
  "targets": {
    "notify":  "fs:oc_xxxxxxxx",
    "confirm": "fs:p2p_xxxxxxxx",
    "summary": "fs:oc_xxxxxxxx"
  },
  "allowedSenders": ["ou_xxxxxxxx"]
}
```

| 字段 | 说明 |
|------|------|
| `targets.notify` | 进度通知目标（群或私聊）|
| `targets.confirm` | 确认/提问目标（建议私聊）|
| `targets.summary` | 任务总结目标 |
| `allowedSenders` | 白名单 open_id 列表；空数组则接受目标聊天任意人的首条回复 |
| `timeout` | `feishu_ask` 最长等待秒数，超时返回 `"timeout"` |
| `httpPort` | hooks 调用的本地 HTTP 端口，默认 7730 |

---

## MCP 工具

### `feishu_notify(message, target?)`

发送通知，立即返回，不等回复。

- `message`：通知内容
- `target`：覆盖 `config.targets.notify`（可选）
- 返回：`{ sent: true }`

**Claude 调用时机**：长任务开始时、完成重要阶段性步骤、遇到非阻断性异常。

---

### `feishu_ask(question, target?, timeout?)`

发送问题，同步阻塞等待飞书回复。

- `question`：问题内容（需包含：正在做什么、为什么需要确认、明确选项）
- `target`：覆盖 `config.targets.confirm`（可选）
- `timeout`：覆盖默认超时秒数（可选）
- 返回：`{ reply: string }` 或 `{ reply: "timeout" }`

**等待机制**：
1. 通过 Feishu REST API 发消息（带 🔔 标记前缀）
2. 注册 pending Promise（唯一 requestId）
3. Feishu WebSocket 收到回复 → resolve；超时计时器触发 → resolve("timeout")

**飞书消息格式**：
```
🔔 Claude Code 需要你的确认

任务：<正在执行的操作>
原因：<为什么需要确认>

请回复：
  ✅ 继续 —— "好"/"是"/"yes"/"ok"/"继续"
  ❌ 取消 —— "不"/"取消"/"no"/"cancel"/"停"
  💬 其他 —— 原文传回 Claude 作为补充信息
```

**Claude 调用时机**：需求模糊需要拍板、发现需求与代码有矛盾、即将做不可逆操作（未被 Hook 捕获）、多步骤任务的中间检查点。

---

### `feishu_summary(summary, target?)`

发送任务总结，立即返回。

- `summary`：结构化总结（完成了什么 / 遗留了什么 / 需要跟进的）
- `target`：覆盖 `config.targets.summary`（可选）
- 返回：`{ sent: true }`

---

## Hooks 设计

### 写入 `~/.claude/settings.json`

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "command",
          "command": "~/.claude/feishu-bridge/scripts/intercept-bash.sh \"$CLAUDE_TOOL_INPUT\""
        }]
      },
      {
        "matcher": ".*",
        "hooks": [{
          "type": "command",
          "command": "~/.claude/feishu-bridge/scripts/check-inbox.sh"
        }]
      }
    ],
    "Stop": [{
      "type": "command",
      "command": "~/.claude/feishu-bridge/scripts/on-stop.sh"
    }]
  }
}
```

---

### Hook 1：`intercept-bash.sh`

拦截高风险 Bash 命令，通过 HTTP 调用 bridge 发飞书确认，阻塞等待。

**拦截模式**：

| 模式 | 原因 |
|------|------|
| `git push.*--force` | 强制覆盖远程历史 |
| `rm -rf` | 递归删除 |
| `git reset --hard` | 丢弃本地修改 |
| `git checkout -- .` / `git restore .` | 批量丢弃工作区变更 |
| `DROP TABLE` / `DROP DATABASE` | 数据库破坏性操作 |
| `> /etc/` / `chmod -R 777` | 系统配置篡改 |

**脚本逻辑**：
```bash
if matches_high_risk "$TOOL_INPUT"; then
  REPLY=$(curl -s -X POST localhost:7730/ask \
    -d "{\"question\": \"即将执行: $TOOL_INPUT\"}")
  APPROVED=$(echo $REPLY | jq -r '.approved')
  [ "$APPROVED" != "true" ] && echo "用户通过飞书拒绝了此操作" >&2 && exit 2
fi
exit 0
```

exit code 2 = Claude Code 阻止工具调用。

---

### Hook 2：`check-inbox.sh`

每次工具调用前检查收件箱，有消息则输出到 stderr（Claude Code 注入上下文）并清空。

```bash
INBOX="$HOME/.claude/feishu-inbox"
if [ -n "$(ls -A $INBOX 2>/dev/null)" ]; then
  echo "=== 飞书新消息 ===" >&2
  cat $INBOX/*.txt >&2
  rm -f $INBOX/*.txt
fi
exit 0
```

---

### Hook 3：`on-stop.sh`

Claude Code 完成回复后自动发任务总结到飞书。默认仅当回复超过 500 字符时触发，避免简单问答也发总结。阈值可在 `feishu-bridge.json` 中通过 `summaryMinLength` 字段覆盖。

---

### Hook 行为汇总

| Hook | 触发时机 | 行为 | 阻塞 Claude？|
|------|---------|------|------------|
| `intercept-bash.sh` | Bash 工具调用前 | 高风险命令 → 飞书确认 | ✅ |
| `check-inbox.sh` | 任意工具调用前 | 注入飞书收件箱消息 | ❌ |
| `on-stop.sh` | Claude 完成回复后 | 发任务总结到飞书 | ❌ |

---

## 进程架构

```
Claude Code 会话
  └── feishu-bridge（MCP stdio 进程）
        ├── MCP 层：处理工具调用请求
        ├── HTTP 层：localhost:7730（hooks 调用入口）
        └── Feishu WS 层：长连接，实时收消息
              ├── 有 pending ask → resolve promise → 返回给 MCP 调用方
              └── 无 pending ask → 写入 feishu-inbox/
```

---

## SKILL.md 内容设计

SKILL.md 包含两个部分：

### Part 1：安装向导（5 个 Phase）

| Phase | 内容 |
|-------|------|
| 1. 预检 | 检查是否已安装；收集 AppID/Secret 和 target chat IDs |
| 2. 安装 Bridge | 复制源码、npm install、编译 |
| 3. 写入配置 | 生成 feishu-bridge.json；更新 settings.json（MCP + hooks + permissions）|
| 4. 获取 open_id | 指导用户获取自己的飞书 open_id 并写入 allowedSenders |
| 5. 验证 | 重启 Claude Code；调用 feishu_notify 发测试消息验证连通 |

### Part 2：Claude 行为指南

指导 Claude Code 何时主动调用飞书工具，消息撰写规范，以及 timeout 时的默认策略：
- 确认操作超时 → 默认取消
- 补充信息超时 → 用已有上下文继续，回复中注明

---

## 超出本设计范围（后续扩展）

- 多 target 动态配置（当前仅支持配置文件中的三个固定 target）
- 飞书卡片消息格式（当前使用纯文本）
- 富文本任务总结（Markdown 转飞书富文本）
- 与 NanoClaw 共享飞书连接（可选集成模式）
