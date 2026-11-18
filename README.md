# myclaude · Claude Code Web

在浏览器里使用本机 Claude Code 的 Web 界面，PC / 移动端均可访问。
视觉语言对齐 [raft.build](https://raft.build/)：cream 底色、ink 描边、硬阴影、
Space Grotesk + Space Mono、黄/粉/青撞色（neo-brutalism）。

## 快速开始

```bash
./start.sh          # 后台启动，默认端口 7801（PORT=xxxx ./start.sh 可改）
```

启动后终端会打印局域网地址，例如 `http://172.20.26.229:7801`。
手机与电脑在同一局域网内直接打开即可。

## 功能

- **新建会话**：选择 `~/.claude/settings.*` 配置（展示每个配置的模型与 API host）、
  工作目录、权限模式（bypassPermissions / acceptEdits / manual / plan）。
- **历史会话**：自动扫描 `~/.claude/projects/*/*.jsonl`，按日期分组；
  支持「查看」（只读回放）与「继续」（`claude --resume`，保留上下文、
  原 settings 与权限模式）。
- **退出会话**：终止 claude 子进程，历史保留，可随时 Resume。
- **专业消息渲染**：Markdown（表格/链接/引用）、代码块语法高亮 + 一键复制、
  思考过程折叠、工具调用卡片（输入/输出可展开、运行/成功/错误状态）、
  每轮耗时 / 费用 / token 统计。
- **流式输出**：`--include-partial-messages` 逐字渲染。
- **权限授权卡片**：manual / acceptEdits 模式下，工具调用弹出 允许/拒绝 卡片
  （`--permission-prompt-tool stdio` + control_request 协议）。
- **多端同步**：同一会话可在 PC 与手机同时打开，消息与授权状态实时广播。
- **移动端适配**：单列布局、底部输入栏（safe-area）、横滑徽章、≥16px 输入框防缩放、
  中文输入法回车不误发送。
- **断线重连**：WebSocket 自动重连并 replay 会话事件缓冲。

## 安全锁

- 刚刚仍在写入的会话（可能正在其它终端运行）默认禁止 resume，需显式「强制恢复」，
  避免分叉一个正在运行的对话。
- 服务重启时按 `data/sessions.json` 记录的 pid 清理遗留 claude 子进程。

## 架构

```
browser ── WebSocket /ws ──> server.js (express + ws)
                              ├─ manager.js   每会话一个 claude 子进程
                              │    claude -p --input-format stream-json
                              │             --output-format stream-json
                              │             --settings <file> [--resume id]
                              ├─ history.js   解析 ~/.claude/projects/*.jsonl
                              └─ data/sessions.json  会话元数据(settings/mode/pid)
```

前端为原生 JS SPA（`public/`），vendored 依赖：marked / DOMPurify / highlight.js，
字体自托管（Space Grotesk / Space Mono），局域网内无需外网。

## 网页会话内自重启（restart.sh）

让网页里的 Claude 修改并重启本服务时，不能直接 `kill + start`：执行重启的 claude
会话是 server 的子进程，server 退出会连带杀死它，重启链断在半路。

`./restart.sh` 把 kill+start 序列放进 `setsid` 脱离的独立会话执行，旧 server 与
claude 会话的死亡都不影响它：

1. 会话内运行 `./restart.sh`（会话 env 里有 `MYCLAUDE_SESSION_ID`，会写 `data/restart.json` 标记）
2. 旧 server 退出，当前会话随之结束（预期行为），独立进程拉起新 server
3. 网页重连后该会话显示只读视图，点 **Resume** 直接继续（标记提供 120s 绿色通道，
   跳过"会话仍在写入"安全锁，无需强制恢复），上下文保留

终端里重启仍用 `./start.sh`（有 active 会话时拒绝，`FORCE=1` 越过）。

## 注意

- 服务监听 `0.0.0.0`，**无鉴权**：仅建议在可信局域网使用；
  获得访问权即等于获得本机 claude 的执行权（尤其 bypassPermissions 模式）。
- 会话历史与 Claude Code CLI 共享（`~/.claude/projects/`），终端与网页可互相 resume。
- 日志：`server.log`；停止服务：`kill $(ss -tlnp | grep :7801 | grep -oP 'pid=\K[0-9]+')`。
