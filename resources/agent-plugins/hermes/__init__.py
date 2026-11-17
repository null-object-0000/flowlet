"""Flowlet 精确会话关联桥 — 为发往 Flowlet 本地代理的请求注入 x-flowlet-session 头。

Hermes 复用 OpenAI Python SDK，原生请求不携带会话标识，Flowlet 无法把请求按会话
归并到 Hermes 原生会话（state.db）。本插件注册 ``llm_request`` 中间件：仅当请求
发往 Flowlet 本地代理（携带 ``x-flowlet-client: hermes`` 标记头）时，把当前 Hermes
会话 id（``sessions.id``）注入 ``x-flowlet-session`` 头；Flowlet 识别后按
``(agent_type, session_id)`` 精确关联，并在转发上游前剥离该头。

该插件由 Flowlet 桌面端受管写入，不修改 Hermes 可执行文件或内置资源；关闭选项后
由 Flowlet 移除。
"""

from __future__ import annotations

FLOWLET_MARKER_HEADER = "x-flowlet-client"
HERMES_MARKER = "hermes"
FLOWLET_SESSION_HEADER = "x-flowlet-session"


def register(ctx) -> None:
    """Hermes 插件入口：注册 LLM 请求中间件。"""
    ctx.register_middleware("llm_request", _inject_flowlet_session)


def _inject_flowlet_session(request, original_request=None, **context):
    """LLM 请求中间件：发往 Flowlet 时注入当前会话 id。

    仅当请求已携带 Flowlet 标记头（说明走 Flowlet 本地代理）才注入，避免污染
    其它 Provider；``session_id`` 来自中间件上下文（Hermes 当前会话 id，与
    state.db 的 ``sessions.id`` 一致）。
    """
    if not isinstance(request, dict):
        return None
    headers = request.get("extra_headers") or {}
    if not isinstance(headers, dict):
        headers = {}
    if headers.get(FLOWLET_MARKER_HEADER) != HERMES_MARKER:
        return None
    session_id = context.get("session_id")
    if not session_id:
        return None
    session_id = str(session_id).strip()
    if not session_id:
        return None
    updated_headers = dict(headers)
    updated_headers[FLOWLET_SESSION_HEADER] = session_id
    updated_request = dict(request)
    updated_request["extra_headers"] = updated_headers
    return {"request": updated_request}
