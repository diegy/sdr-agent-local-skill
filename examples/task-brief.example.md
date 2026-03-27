# SDR 自动测试任务说明

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
curl 'https://example.com/sse/agent/conversation/completions' \
  -H 'content-type: application/json' \
  --data-raw '{"content":[{"type":"text","text":"你好"}],"sessionId":"agent_debug_demo"}'
```
