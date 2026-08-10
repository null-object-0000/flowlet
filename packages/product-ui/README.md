# Flowlet Product UI

Flowlet 桌面端、移动端与官网共用的纯展示层。

规则：

- 只接收序列化数据、展示文案和回调；
- 不导入 Tauri command、TanStack Query、应用 Router 或业务 Hook；
- 不读取真实配置、凭据或运行环境；
- 实际应用由页面容器注入真实数据，官网由 fixtures 注入演示数据。
