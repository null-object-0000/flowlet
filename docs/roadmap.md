# Roadmap

## 阶段一：桌面端 MVP

- Tauri 桌面客户端
- 本地代理服务
- Provider 配置
- Client Token 配置
- OpenAI-compatible 透明转发
- 响应零改写
- 基础请求日志
- 基础 Token / 成本分析
- 虚拟模型 `auto`

## 阶段二：路由增强

- 多虚拟模型
- 顺序降级
- 免费额度优先策略
- 模型价格表
- 日志搜索
- 按客户端 / Provider / 模型聚合统计

## 阶段三：Docker / Web Console

- Core 支持 headless 运行
- Web Console
- Docker Compose
- Volume 持久化
- 基础访问鉴权

## 阶段四：智能路由

- 规则路由
- 请求类型识别
- 小模型路由判断
- 成本 / 延迟 / 成功率综合调度
