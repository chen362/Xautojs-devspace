<p align="center">
  <picture>
    <img src="docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">Xautojs DevSpace</h1>

<p align="center">面向 ChatGPT 的自托管 MCP 工作区桥接层与原生本地 Agent Runtime。</p>

<p align="center">
  <a href="README.md">English</a> | 中文
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/chen362/Xautojs-devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/chen362/Xautojs-devspace/ci.yml?style=flat-square&branch=Xautojs-devspace" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](docs/assets/devspace-screenshot.png)](docs/assets/devspace-screenshot.png)

## 这个项目是什么

Xautojs DevSpace 从 DevSpace 的本地 MCP 工作区模型出发，继续扩展成一个
Xautojs 自有的原生本地 Agent Runtime。

它允许 ChatGPT 或其他支持 MCP 的宿主，通过明确的工具访问你授权的本地项目目录，
同时把执行留在你自己的机器上：

- 打开已授权的本地工作区
- 读取、写入、编辑、搜索和检查项目文件
- 运行本地测试、构建、git、包管理脚本等命令
- 使用隔离的 Git worktree 支持并行编码任务
- 读取项目内的 `AGENTS.md` 和 `CLAUDE.md` 指令
- 发现本地 agent skills
- 在兼容 ChatGPT Apps 的宿主里展示工具卡片和变更摘要

Xautojs 分支还增加了面向生产和自动化的能力：

- 基于 Postgres 的 workspace、automation、native agent 状态存储
- 通用 automation trigger 和 GitHub webhook 入口
- GitHub webhook 签名校验、事件去重和路由策略
- 第一方 native agent run、事件流、进程执行和 workflow pack
- 权限 profile、approval 暂停/恢复、runtime hooks、retry、replay 和 operator API
- 面向 operator 的 CLI：dispatch、replay、approval、retry、cancel 等

Codex 和 Claude Code 在这里是参考系统，不是运行时依赖。Xautojs 自己拥有 runtime、
storage、policy、hooks、workflow packs 和 operator controls，不要求安装 Codex 或
Claude Code 二进制。

## 包名说明

当前仓库仍沿用上游 CLI 包名：

```bash
@waishnav/devspace
```

当前默认开发分支是：

```text
Xautojs-devspace
```

请以默认分支上的文档作为 Xautojs runtime 功能的准确信息来源。

## 快速开始

DevSpace 需要 Node `>=20.12 <27`。推荐使用 Node 22 LTS。

安装 CLI：

```bash
npm install -g @waishnav/devspace
```

初始化并启动服务：

```bash
devspace init
devspace serve
```

也可以不全局安装，直接使用 npx：

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

初始化时会询问：

- ChatGPT 可以打开哪些本地项目目录
- 本地端口，通常是 `7676`
- 通过 Cloudflare Tunnel、ngrok、Pinggy、Tailscale Funnel 或自建反向代理得到的公网 HTTPS 地址

初始化时填写公网 origin，不要带 `/mcp`：

```text
https://your-tunnel-host.example.com
```

MCP 客户端里配置完整的 `/mcp` 地址：

```text
https://your-tunnel-host.example.com/mcp
```

当客户端连接时，DevSpace 会打开 Owner password 审批页。输入 `devspace init`
打印的 Owner password。它也会保存在：

```text
~/.devspace/auth.json
```

请妥善保管这个文件和密码。

## 使用心智模型

DevSpace 本质上是对选定本地目录的远程访问。

你决定哪些目录可以被打开。连接上的 MCP 客户端在已打开的 workspace 内仍然拥有较强
能力，包括 shell 执行。应把连接上的客户端视为一个受信任的本地编码协作者。

一次普通 ChatGPT 编码会话通常是：

1. 启动 tunnel。
2. 运行 `devspace serve`。
3. 在 MCP 客户端里连接公网 `/mcp` 地址。
4. 用 Owner password 批准连接。
5. 让 ChatGPT 打开 allowed roots 里的某个项目目录。

## Production Postgres

SQLite 仍然是本地默认数据库。生产 workspace 状态、automation 入口和 native agent
operator 工作流需要 Postgres。

生产部署前先运行迁移：

```bash
DEVSPACE_DEPLOYMENT_MODE="production" \
DEVSPACE_AUTH_MODE="oidc" \
DEVSPACE_OIDC_ISSUER="https://auth.example.com" \
DEVSPACE_OIDC_AUDIENCE="https://devspace.example.com/mcp" \
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
DEVSPACE_POSTGRES_SSL_MODE="require" \
npx @waishnav/devspace db migrate
```

用 JSON 输出检查 schema 是否 ready：

```bash
DEVSPACE_DATABASE_PROVIDER="postgres" \
DEVSPACE_DATABASE_URL="postgres://devspace:secret@db.example.com:5432/devspace" \
npx @waishnav/devspace db status --json
```

然后用相同的数据库配置启动服务。`devspace serve` 会在接受流量前检查迁移状态。
运行时探针包括 `/healthz` 和 `/readyz`。

## Automation 入口

Automation source 是 owner-scoped，并基于 Postgres 存储。当前入口包括：

```text
POST /api/automation/triggers/:triggerId/fire
POST /api/automation/github/webhooks/:sourceId
```

GitHub webhook 入口会校验 `X-Hub-Signature-256`，对 delivery 去重，应用 source
routing policy，然后把事件排队成 automation work，或作为 audit-only ignored event
记录下来。

Source token 通过这些命令管理：

```bash
devspace automation source create
devspace automation source list
devspace automation source rotate-token
```

## Native Agent Runtime

Native runtime 把排队的 automation work 变成可审计的本地执行。

核心存储包括：

```text
agent_runs
agent_run_events
agent_tool_calls
agent_runtime_hooks
```

Native run 的状态比 automation run 更细：

```text
queued -> claiming -> running -> waiting_input -> succeeded | failed | cancelled | timed_out
```

内置 workflow packs 包括：

```text
manual
github-pr-review
feature-dev
security-review
test-fix
```

Runtime hooks 是类型化且可 replay 的：

```text
Start
WorkflowStep
PreToolUse
PostToolUse
PermissionRequest
PostCompact
Stop
```

每一次 hook decision 都会镜像进入 run event stream，事件类型是
`run.hook.decision`。这样 operator replay 可以看到生命周期 hook 和 workflow step
状态。旧的 hook table 仍然保留 `PreToolUse`、`PostToolUse`、`PermissionRequest`、
`PostCompact`、`Stop` 这些 legacy hook 记录。

## Operator CLI

Native agent 命令需要 Postgres。Operator HTTP API 还需要配置：

```text
DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN
```

常见 CLI 流程：

```bash
devspace agent workflows
devspace agent dispatch-once --workspace-root /path/to/workspace
devspace agent list
devspace agent replay --id <agentRunId>
devspace agent approvals --id <agentRunId>
devspace agent approve --id <agentRunId> --approval-id <approvalId>
devspace agent deny --id <agentRunId> --approval-id <approvalId>
devspace agent resume --id <agentRunId> --workspace-root /path/to/workspace
devspace agent retry --id <agentRunId>
devspace agent cancel --id <agentRunId>
```

`devspace agent replay --id <agentRunId>` 默认输出面向 operator 的摘要：run 状态、
workflow、approval 计数、hook decision 计数、workflow step 状态、最新 pending
approval、blocking hooks 和 retry 链接。需要完整机器可读事件流时使用 `--json`。

## Operator API

Native agent operator API 挂载在：

```text
/api/native-agent
```

请求需要：

```text
Authorization: Bearer <DEVSPACE_NATIVE_AGENT_OPERATOR_TOKEN>
```

重要端点：

```text
GET  /api/native-agent/runs
GET  /api/native-agent/runs/:agentRunId/events
GET  /api/native-agent/runs/:agentRunId/replay
GET  /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals
POST /api/native-agent/runs/:agentRunId/approvals/:approvalId/resolve
POST /api/native-agent/runs/:agentRunId/resume
POST /api/native-agent/runs/:agentRunId/retry
POST /api/native-agent/runs/:agentRunId/cancel
POST /api/native-agent/dispatch/once
POST /api/native-agent/dispatch/run
```

完整契约见 [Native Agent Runtime](docs/native-agent-runtime.md)。

## 平台支持

DevSpace 支持 Linux、macOS 和 Windows 环境。

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Linux | 支持 | MCP shell 工作流需要 Node、npm、Git 和 Bash。 |
| macOS | 支持 | MCP shell 工作流需要 Node、npm、Git 和 Bash。 |
| Windows with Git Bash, WSL, MSYS2, or Cygwin Bash | 支持 | Git Bash 是最简单的 Windows 原生配置。 |
| Windows PowerShell or `cmd.exe` only | 部分支持 | native agent process engine 避免 shell 假设，但 MCP shell 工作流仍期望 Bash-compatible shell。 |

检查本地环境：

```bash
devspace doctor
```

## 文档

- [English README](README.md)
- [Setup Guide](docs/setup.md)
- [ChatGPT Coding Workflow](docs/chatgpt-coding-workflow.md)
- [Configuration Reference](docs/configuration.md)
- [Production Smoke Check](docs/production-smoke.md)
- [DevSpace Automation Ingress Plan](docs/devspace-automation-ingress-plan.md)
- [Native Agent Runtime](docs/native-agent-runtime.md)
- [Security Model](docs/security.md)
- [Troubleshooting Gotchas](docs/gotchas.md)

## 本地开发

开发本仓库：

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```

如果有可用的 Postgres 测试库，可以运行集成测试：

```bash
DEVSPACE_DATABASE_URL="postgres://devspace:secret@127.0.0.1:5432/devspace_test" \
DEVSPACE_POSTGRES_SSL_MODE="disable" \
npm run test:postgres
```

## License

MIT.
