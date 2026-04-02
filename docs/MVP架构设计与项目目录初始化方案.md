# 桌面桌宠 AI MVP 架构设计与项目目录初始化方案

## 1. 文档目标

本文档用于定义桌面桌宠 AI 项目的 MVP 工程结构和首版开发边界，目标是让项目可以尽快进入可开发状态，并保证后续易于扩展。

适用阶段：

- 0 到 6 周的首版开发
- 单人或小团队推进
- Windows 桌面优先

本文档聚焦：

- MVP 架构拆分
- 项目目录初始化
- 模块边界
- 进程通信
- 数据存储
- 开发顺序

不覆盖内容：

- 详细数据库字段设计
- 详细 Prompt 文案
- 角色设定内容细节

## 2. MVP 总目标

首版目标不是做成完整 AI 助手，而是验证以下核心体验：

- 桌面上存在一个可交互的桌宠角色
- 用户可以和它进行文字对话
- 它可以播报回复
- 它能基于简单规则主动说话
- 它能感知少量本地环境信息
- 它具有基础的角色状态和短期记忆

MVP 的验证标准：

- 用户第一次打开后可以立刻看见桌宠并交互
- 对话响应流程稳定
- 不会频繁卡顿或无响应
- 主动行为不令人厌烦
- 后续功能增加时不需要推翻首版架构

## 3. 首版总体架构

建议使用 Monorepo，并分成两个主应用和若干共享包。

核心结构：

- `desktop-shell`：桌面外壳和渲染层
- `local-service`：本地服务层，处理 AI、调度、状态机、存储和系统事件

首版建议的进程模型：

1. Electron Main Process
2. Electron Renderer Process
3. Node Local Service Process

职责划分：

### 3.1 Electron Main Process

负责：

- 创建透明桌宠窗口
- 创建聊天窗口或设置窗口
- 托盘图标和菜单
- 全局快捷键
- 与本地服务建立 IPC 通信
- 管理窗口显示与隐藏

不负责：

- 直接调用模型
- 直接处理复杂状态机
- 直接读写业务数据库

### 3.2 Electron Renderer Process

负责：

- 渲染角色 UI
- 显示聊天气泡和聊天面板
- 呈现动画状态
- 接收用户输入
- 展示设置页和调试页

不负责：

- 复杂业务编排
- 长期记忆决策
- 直接访问敏感系统能力

### 3.3 Local Service

负责：

- LLM 调用
- Prompt 组装
- 会话管理
- 状态机和主动行为规则
- 短期记忆和长期记忆写入
- 系统事件监听和调度
- 对外暴露内部 API 或 IPC 接口

这是业务核心，建议从一开始就和 UI 分开。

## 4. 推荐技术栈

MVP 建议如下：

- 桌面框架：`Electron`
- 前端框架：`React`
- 语言：`TypeScript`
- 构建：`Vite`
- 包管理：`pnpm`
- Monorepo：`pnpm workspace`
- 本地数据库：`SQLite`
- ORM：`Drizzle ORM`
- 运行时校验：`zod`
- 日志：`pino`
- 前端状态：`Zustand`
- 测试：`Vitest`
- 进程通信：Electron IPC + 本地服务 HTTP/IPC 二选一

建议首版本地服务使用 Node.js，减少技术栈分裂。

## 5. 目录结构设计

建议初始化为如下结构：

```text
zhuochong/
  apps/
    desktop-shell/
      electron/
      src/
      public/
      package.json
      tsconfig.json
      vite.config.ts
    local-service/
      src/
      package.json
      tsconfig.json
  packages/
    shared/
      src/
    event-bus/
      src/
    prompt-engine/
      src/
    memory-core/
      src/
    system-tools/
      src/
    ui-contracts/
      src/
  assets/
    character/
      base/
      emotions/
      motion/
    audio/
    icons/
  data/
    dev/
  docs/
  scripts/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .gitignore
  .env.example
```

## 6. 各目录职责

### 6.1 `apps/desktop-shell`

这个应用是用户直接看到的桌面端程序。

建议进一步拆分：

```text
apps/desktop-shell/
  electron/
    main.ts
    preload.ts
    windows/
    tray/
    ipc/
  src/
    app/
    components/
    features/
    stores/
    hooks/
    pages/
    styles/
    types/
```

推荐模块职责：

- `electron/main.ts`：Electron 入口
- `electron/preload.ts`：暴露安全桥 API
- `electron/windows/`：窗口创建和窗口管理
- `electron/tray/`：托盘逻辑
- `electron/ipc/`：主进程 IPC handlers
- `src/features/pet/`：桌宠角色 UI 与动画
- `src/features/chat/`：聊天面板
- `src/features/settings/`：设置页面
- `src/features/debug/`：调试面板
- `src/stores/`：前端状态管理

### 6.2 `apps/local-service`

这个应用是业务逻辑中心。

建议结构：

```text
apps/local-service/
  src/
    index.ts
    server/
    ai/
    behavior/
    memory/
    events/
    tools/
    repositories/
    scheduler/
    config/
    types/
```

推荐模块职责：

- `server/`：服务入口、接口注册
- `ai/`：模型调用、提示词组装、响应解析
- `behavior/`：状态机、主动行为规则、冷却控制
- `memory/`：短期记忆、摘要、长期记忆接口
- `events/`：事件标准化、分发、订阅
- `tools/`：时间、电量、前台应用等工具
- `repositories/`：数据库访问层
- `scheduler/`：定时任务和节流策略
- `config/`：环境变量与启动配置

### 6.3 `packages/shared`

放跨应用复用的基础定义：

- 通用类型
- 枚举
- 常量
- 时间工具
- 错误定义

### 6.4 `packages/ui-contracts`

这里很关键，用于定义桌宠 UI 和本地服务之间的协议。

内容包括：

- 请求参数类型
- 响应结构类型
- 事件 payload 类型
- 状态机状态枚举

这样可以避免 Electron 主进程、渲染层、本地服务三方协议漂移。

### 6.5 `packages/event-bus`

用于抽象事件模型，例如：

- `USER_CHAT_SUBMITTED`
- `PET_CLICKED`
- `FOREGROUND_APP_CHANGED`
- `SCHEDULE_REMINDER_DUE`
- `PET_SPEECH_REQUESTED`

### 6.6 `packages/prompt-engine`

负责：

- 角色设定模板
- 对话 Prompt 模板
- 行为决策 Prompt 模板
- 记忆提取 Prompt 模板

### 6.7 `packages/memory-core`

负责：

- 记忆结构定义
- 检索策略
- 摘要策略
- 记忆写入规则

### 6.8 `packages/system-tools`

负责封装平台能力：

- 获取当前时间
- 获取电量信息
- 获取前台应用
- 查询天气

首版要控制数量，不要一开始做太多工具。

## 7. MVP 模块边界

首版推荐只做以下业务模块。

### 7.1 必做模块

- 桌宠窗口模块
- 聊天模块
- TTS 模块
- 角色状态模块
- 事件调度模块
- 短期记忆模块
- 设置模块

### 7.2 可延后模块

- 语音输入模块
- 长期记忆模块
- 文件搜索模块
- 日历同步模块
- 自动执行模块

## 8. 通信设计

建议通信分两层：

1. Renderer 与 Main：Electron IPC
2. Main 与 Local Service：本地 HTTP 或本地 IPC

MVP 为了实现简单，推荐：

- Renderer <-> Main：Electron IPC
- Main <-> Local Service：本地 HTTP `localhost`

理由：

- 调试直观
- 本地服务可以独立启动和测试
- 后续切换成本较低

建议接口风格：

- `POST /chat/respond`
- `POST /behavior/evaluate`
- `GET /pet/state`
- `POST /speech/speak`
- `GET /system/context`

事件推送可以先用轮询或简单双向通道，首版不必过度设计。

## 9. 首版核心数据流

### 9.1 用户聊天流

1. 用户在聊天面板输入文本
2. Renderer 通过 IPC 发送给 Main
3. Main 转发给 Local Service
4. Local Service 查询当前状态和短期记忆
5. 组装 Prompt
6. 调用模型
7. 解析出回复文本、情绪、动作建议
8. 写入对话记录
9. 返回 Main
10. Main 通知 Renderer 更新 UI
11. 若需要播报，则触发 TTS

### 9.2 主动提醒流

1. Scheduler 触发定时事件
2. Behavior 模块判断是否允许打扰
3. 若允许，则生成提醒内容
4. 通知桌宠显示气泡
5. 需要时调用 TTS

### 9.3 系统感知流

1. Tool 模块监听前台应用变化或周期轮询
2. 事件标准化为统一格式
3. Event Bus 分发
4. Behavior 模块决定是否影响角色状态
5. UI 更新表情或显示简短反馈

## 10. 配置与环境变量

根目录建议提供 `.env.example`：

```env
NODE_ENV=development
APP_PORT=3765
LOG_LEVEL=debug
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
TTS_PROVIDER=system
WEATHER_API_KEY=
DB_PATH=./data/dev/zhuochong.db
```

建议分级：

- 基础配置：应用端口、日志级别、数据库路径
- AI 配置：模型名称、API 地址、密钥
- 工具配置：天气、日历等第三方密钥
- 用户配置：角色名、播报开关、主动提醒开关

## 11. 数据库初始化建议

MVP 阶段建议最少建立这几张表：

- `conversation_messages`
- `session_memory`
- `user_preferences`
- `pet_state_snapshots`
- `scheduled_events`
- `app_settings`

首版数据库职责：

- 保存聊天记录
- 保存短期记忆摘要
- 保存用户设置
- 保存角色状态快照

不建议首版做复杂向量数据库，先用结构化表和简单检索即可。

## 12. 角色状态管理设计

首版状态建议：

- `idle`
- `talking`
- `thinking`
- `happy`
- `concerned`
- `sleeping`

前端只负责渲染状态，不负责决定状态。

服务层统一输出：

```json
{
  "petState": "happy",
  "shouldSpeak": true,
  "bubbleText": "今天也很努力呢。",
  "ttsText": "今天也很努力呢。",
  "moodScore": 0.72
}
```

这样前端只要根据 `petState` 切换动画资源即可。

## 13. 初始化脚手架建议

建议第一天就完成以下初始化：

1. 建立 `pnpm workspace`
2. 创建 `apps/desktop-shell`
3. 创建 `apps/local-service`
4. 创建 `packages/shared`
5. 创建 `packages/ui-contracts`
6. 配置根级 TypeScript 基础配置
7. 配置 ESLint、Prettier、Vitest
8. 跑通桌宠空窗口
9. 跑通本地服务 hello world 接口
10. 跑通 UI 到服务的一次通信

首个里程碑不要求桌宠会聊天，只要求“壳”和“服务”接通。

## 14. 开发顺序建议

### 第一周

- 初始化仓库
- 搭建 Electron 壳
- 建立透明窗口
- 实现托盘和基础设置
- 建立本地服务
- 打通 UI 与服务通信

### 第二周

- 接聊天面板
- 接入模型 API
- 返回基础文字回复
- 增加状态切换

### 第三周

- 加入 TTS
- 加入短期记忆
- 加入角色气泡和基础主动行为

### 第四周

- 接入时间、电量、前台应用
- 完善冷却规则和免打扰
- 做设置页和日志页

### 第五到六周

- 修性能
- 补异常处理
- 优化角色感
- 做安装包和自启动能力

## 15. 工程约束建议

为了避免首版失控，建议设定以下约束：

- 不做多角色
- 不做复杂插件系统
- 不做自动操作电脑
- 不做实时麦克风常驻监听
- 不做多模型编排
- 不做过度抽象的微服务化

首版关键是“能跑、稳定、可扩展”，不是技术展示。

## 16. 调试与可观测性

建议一开始就做基础调试能力。

至少包含：

- 本地服务日志
- Electron 主进程日志
- 前端错误日志
- 当前状态机状态查看
- 最近事件列表
- 最近一次模型请求摘要

推荐增加一个隐藏调试页，便于快速排查：

- 当前角色状态
- 冷却剩余时间
- 当前前台应用
- 最近 20 条事件
- 最近 5 轮对话

## 17. 首版验收标准

达到以下标准可以视为 MVP 可用：

- 应用启动后 3 秒内桌宠可见
- 点击角色能打开交互面板
- 输入文本后能稳定得到回复
- 回复能切换动画和播报
- 最少支持一种主动提醒
- 关闭和重开后设置能保留
- 空闲时资源占用可接受

## 18. 下一步文档建议

在本架构文档之后，最适合继续补这两份：

1. `数据库表结构和事件模型设计`
2. `角色状态机与 Prompt 设计文档`

如果开始写代码，则建议按本文件的目录结构直接初始化工程，不要等全部文档写完再动手。
