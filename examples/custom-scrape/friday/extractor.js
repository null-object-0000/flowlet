// 注意：本文件必须是**单个顶层函数声明**。Rust 以 (extractor_js)(bundle, credential)
// 的形式调用它，顶层出现第二个语句/函数会直接变成语法错误，而 wry 会把 JS 异常吞成
// 空字符串（表现为「extractor 未返回任何结果」）。helper 一律内联在 extract 内。
function extract(bundle, credential) {
  // Friday 控制台 /api-keys 返回的是同 workspace 下的多把 key（knowledge / public /
  // resource-mark），它们的额度各自独立。旧实现固定取「当月消费最高」的那把，
  // 结果跟踪到的 key 与本账号实际发请求用的 key 可能不是同一把。
  //
  // 现在优先用 Rust 传入的账号凭据指纹（第二个实参 credential）认出本账号实际使用的
  // key：控制台只返回 key_prefix（前 8 位）与 key_last_four，Rust 侧用同一组字段
  // 从账号 API Key 派生指纹，因此两边可以直接对账。
  // 指纹缺失或对不上时，回退到旧的「当月消费最高」策略，并在 plan_name 里标注回退，
  // 避免再次静默跟踪到错误的 key。
  function matchesAccountKey(item, context) {
    if (!item || !context) return false;
    var prefix = String(item.key_prefix || "").trim().toLowerCase();
    var lastFour = String(item.key_last_four || "").trim().toLowerCase();
    var wantPrefix = String(context.keyPrefix || "").trim().toLowerCase();
    var wantLastFour = String(context.keyLastFour || "").trim().toLowerCase();
    if (!prefix || !lastFour || !wantPrefix || !wantLastFour) return false;
    if (lastFour !== wantLastFour) return false;
    // 控制台返回的前缀长度可能变化，双向前缀匹配，避免长度不一致时误判。
    return prefix === wantPrefix
      || wantPrefix.indexOf(prefix) === 0
      || prefix.indexOf(wantPrefix) === 0;
  }

  function pickHighestCost(items) {
    var sorted = items.slice().sort(function (a, b) {
      return (Number(b.current_month_cost) || 0) - (Number(a.current_month_cost) || 0);
    });
    return sorted[0] || null;
  }

  try {
    var data = bundle && bundle.usage ? bundle.usage : null;
    if (!data || !Array.isArray(data.items)) return null;
    var active = data.items.filter(function (it) { return it && it.status === "ACTIVE"; });
    if (!active.length) active = data.items.slice();
    var key = null;
    for (var i = 0; i < active.length; i++) {
      if (matchesAccountKey(active[i], credential)) {
        key = active[i];
        break;
      }
    }
    var matched = key !== null;
    if (!matched) key = pickHighestCost(active);
    if (!key) return null;
    var credit = Number(key.credit_money) || 0;
    var cost = Number(key.current_month_cost) || 0;
    var remaining = Math.max(0, credit - cost);
    return {
      balance: Number(remaining.toFixed(2)),
      currency: "CNY",
      plan_name: "Friday 按量付费 · " + (key.name || ("key-" + key.id))
        + (matched ? "" : "（回退：当月消费最高）"),
      token_total: Math.round(credit),
      token_used: Math.round(cost),
      token_remaining: Math.round(remaining),
      token_expire_at: null
    };
  } catch (e) {
    return null;
  }
}
