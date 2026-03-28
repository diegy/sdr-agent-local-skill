# SDR Agent 完整测试流程

这套测试工具目前支持两种模式：

- `龙虾 / Claude / Codex 测试模式`
  使用本地 AI 驱动自动跑多轮会话、自动评分并生成报告
- `手动测试模式`
  使用微应用页面 + 本地代理服务，手工发起测试

---

## 一、先获取 curl

无论用哪种模式，第一步都建议先抓到官网客服这条链路的 `sendMessage` curl。

### 获取步骤

1. 用 Chrome 无痕窗口打开这个页面  
   `https://www.fxiaoke.com/doc/fktest1824-test`

2. 确认当前是未登录态  
   这个客服入口在未登录时才出现。

3. 按 `F12` 打开开发者工具，切到 `Network`，勾上 `Preserve log`  
   这样点开客服和发消息后，请求不会丢。

4. 在 `Network` 上方过滤框里先输入：

```text
sendMessage
```

5. 回到页面，点右下角客服入口，输入一句话  
   例如：

```text
制造业
```

6. 回到 `Network`，找到这条请求：

```text
.../online/consult/comm/chat/sendMessage?...
```

7. 右键这条请求：

```text
Copy -> Copy as cURL (bash)
```

8. 把这段 curl 直接贴进测试工具

---

## 二、龙虾 / Claude / Codex 测试模式

这个模式适合：

- 想让 AI 自己批量跑多个测试方向
- 想自动完成多轮对话
- 想自动评分、自动生成报告
- 想记录逐轮时间、耗时、traceId、sessionId 等信息

### 下载地址

- Skill 仓库：
  [https://github.com/diegy/sdr-agent-local-skill](https://github.com/diegy/sdr-agent-local-skill)
- ZIP 下载：
  [https://github.com/diegy/sdr-agent-local-skill/archive/refs/heads/main.zip](https://github.com/diegy/sdr-agent-local-skill/archive/refs/heads/main.zip)

如果用 git 拉取：

```bash
git clone https://github.com/diegy/sdr-agent-local-skill.git
```

### 需要准备什么

1. 一份官网客服 `sendMessage` 的 curl
2. 本机可用的 AI 驱动
   目前支持：
   - `Codex`
   - `Claude Code`
   - `OpenClaw / 龙虾`

### 推荐使用方式

这个模式推荐直接写一份自然语言任务说明，然后让 runner 自动解析。

仓库里有示例文件：

- [examples/task-brief.example.md](examples/task-brief.example.md)

你可以照这个格式写，例如：

````md
请帮我测试官网客服这条链路。

目标：
- 看看它在多轮对话里有没有记忆
- 看看它对价格、功能、实施周期这几个方向的应答质量

测试参数：
- 每个方向跑 3 个独立会话
- 每个会话连续对话 5 轮
- 中间如果请求失败、没回复或者返回空内容，就立刻中断，不要空跑

用户画像：
- 制造业销售负责人

历史背景：
- 首次咨询 CRM，希望快速判断产品是否适合中小团队

测试方向：
- 咨询产品价格和报价方式
- 咨询 CRM 核心功能和典型使用场景
- 咨询实施周期、上线方式和培训支持

目标请求 curl：

```bash
curl '......'
```
````

### 运行方式

进入项目目录：

```bash
cd sdr-agent-local-skill
```

#### 方式 A：直接使用自然语言任务说明

```bash
node src/index.mjs --brief examples/task-brief.example.md
```

如果想强制指定本地 AI 驱动，可以追加：

```bash
node src/index.mjs --brief examples/task-brief.example.md --driver-preset codex
```

或：

```bash
node src/index.mjs --brief examples/task-brief.example.md --driver-preset claude
```

或：

```bash
node src/index.mjs --brief examples/task-brief.example.md --driver-preset openclaw
```

#### 方式 B：使用 JSON 配置

仓库内置了三个示例：

- `examples/task.example.json`
- `examples/task.claude.example.json`
- `examples/task.openclaw.example.json`

例如：

```bash
node src/index.mjs --config examples/task.example.json
```

### 输出结果

每次执行后，都会在 `reports/` 下生成一个新目录，里面包含：

- `report.md`
  面向阅读的完整报告
- `report.json`
  完整结构化结果
- `turns.json`
  拉平后的逐轮数据
- `turns.csv`
  适合导入表格或二次分析的逐轮数据

### 这个模式会记录什么

除了对话内容和评分，还会记录：

- 每个方向的测试结果
- 每个会话的平均耗时、最大耗时
- 每一轮的：
  - 用户消息时间
  - 发起请求时间
  - 收到回复时间
  - 响应耗时
  - `traceId`（如果链路里有）
  - `requestUrl`
  - `sessionId`
  - `conversationId`

### 常见问题

#### 1. 没指定驱动会怎么样

如果没有显式指定驱动，runner 会自动按这个顺序探测：

```text
codex -> claude -> openclaw
```

哪个先可用，就优先用哪个。

#### 2. OpenClaw / 龙虾跑不起来

这通常说明本机没有正确安装 `openclaw` 命令，或者实际命令名不同。  
这时可以在 JSON 里手工指定 `command` 或 `shellCommand`。

#### 3. 中途失败会不会继续空跑

默认不会。  
这套工具默认是：

```text
stopOnError = true
```

只要关键步骤失败，就会立即中断。

---

## 三、手动测试模式

这个模式适合：

- 需要用微应用页面手工观察对话过程
- 需要人工调试微应用页面
- 需要联调官网客服真实链路

### 下载地址

- 微应用仓库：
  [https://github.com/diegy/sdr-agent-testbench-microapp](https://github.com/diegy/sdr-agent-testbench-microapp)
- ZIP 下载：
  [https://github.com/diegy/sdr-agent-testbench-microapp/archive/refs/heads/main.zip](https://github.com/diegy/sdr-agent-testbench-microapp/archive/refs/heads/main.zip)

如果用 git 拉取：

```bash
git clone https://github.com/diegy/sdr-agent-testbench-microapp.git
```

### 一、起本地代理服务

#### 1. 需要先安装

- Node.js 20 或更高版本
- npm 10 或更高版本

检查是否已安装：

```bash
node -v
npm -v
```

如果终端能正常显示版本号，就可以继续。

如果没安装：

- macOS：安装 [Node.js](https://nodejs.org/)
- Windows：安装 [Node.js](https://nodejs.org/)，安装后重新打开终端

#### 2. 进入服务目录

先进入项目目录，再进入 `service`：

```bash
cd /你的项目目录
cd service
```

#### 3. 安装依赖

第一次使用时，需要先安装依赖：

```bash
npm install
```

安装完成后，会生成 `node_modules` 目录。

#### 4. 创建本地配置文件

这个服务默认需要一个 `.env.local` 文件。

先复制模板文件：

macOS / Linux：

```bash
cp .env.example .env.local
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env.local
```

Windows CMD：

```cmd
copy .env.example .env.local
```

默认配置内容如下：

```env
PORT="3010"
CORS_ORIGIN="*"
```

通常不需要改。

说明：

- `PORT`：本地服务端口，默认 `3010`
- `CORS_ORIGIN`：允许跨域访问，默认 `*`

#### 5. 启动本地代理服务

macOS / Linux：

```bash
npm run dev
```

Windows PowerShell：

```powershell
npm run dev
```

Windows CMD：

```cmd
npm run dev
```

启动成功后，终端会看到类似提示：

```text
SDR microapp proxy service running on http://127.0.0.1:3010
```

这就说明服务已经启动成功。

#### 6. 微应用页面里的代理服务地址填写

```text
http://127.0.0.1:3010
```

#### 7. 常见问题

##### 1. `node` 或 `npm` 命令找不到

说明本机没有正确安装 Node.js，先安装后再试。

##### 2. `npm install` 失败

一般是网络问题，重新执行一次即可；如果公司网络有限制，可能需要配置 npm 镜像。

##### 3. 页面连不上代理服务

先检查：

- 服务是否还在运行
- 页面里填写的地址是不是 `http://127.0.0.1:3010`
- 端口是否被占用
- 防火墙是否拦截了 `3010`

##### 4. 提示 `FsYxtMicroApp.llm` 未注入

这不是本地服务问题，而是微应用运行环境没有提供云端 LLM 能力。

##### 5. 如何停止服务

在运行服务的终端窗口里按：

- macOS：`Control + C`
- Windows：`Ctrl + C`

如果提示是否终止，输入 `Y` 再回车即可。

---

## 四、怎么选模式

如果你要：

- 自动批量跑多个聊天方向
- 自动多轮对话
- 自动评分
- 自动产出结构化报告

优先使用：

```text
龙虾 / Claude / Codex 测试模式
```

如果你要：

- 手工观察页面交互
- 联调微应用页面
- 手动点点看客服链路

优先使用：

```text
手动测试模式
```
