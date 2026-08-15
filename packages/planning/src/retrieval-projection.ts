import {
  RetrievalProjectionSchema,
  SCHEMA_VERSIONS,
  type NormalizedTravelRequest,
  type RetrievalProjection,
  type TravelPlanContent,
} from '@tps/schemas';

/**
 * 由 `plan_json` 裁剪出脱敏投影（TP-2-20，设计稿 3.2.4）。
 *
 * ## 纯函数，且是**逐字段显式构造**
 *
 * 不用 `structuredClone` + `delete` 的减法写法。减法的失效模式是沉默的：
 * `TravelPlan` 新增一个字段，它会自动流进投影，没有任何测试会失败 ——
 * 直到有人发现别人的行程细节出现在自己的生成上下文里。
 * 加法写法下，新字段默认不进投影，最坏结果只是检索质量略降。
 *
 * 这也是 RISK-14 四层防护的第一层。另外三层：
 *   `plan_embedding` 由投影计算（TP-2-21）、仓储返回类型不含 `plan_json`
 *   （编译期）、数据库列级 `GRANT`（运行期最后防线，15.2）。
 */

export function buildRetrievalProjection(plan: TravelPlanContent): RetrievalProjection {
  return {
    schema_version: SCHEMA_VERSIONS.retrievalProjection,
    destination: {
      name: plan.destination.name,
      place_id: plan.destination.place_id,
    },
    total_days: plan.total_days,
    days: plan.days.map((day) => ({
      theme: day.theme,
      subtitle: day.subtitle,
      schedule: day.schedule.map((item) => ({
        title: item.title,
        period: item.period,
        duration_minutes: item.duration_minutes,
        description: item.description,
        location: {
          name: item.location.name,
          place_id: item.location.place_id,
        },
      })),
      food_recommendations: day.food_recommendations.map((food) => ({
        name: food.name,
        entity_type: food.entity_type,
      })),
      route_recommendations: day.route_recommendations.map((route) => ({
        nodes: [...route.nodes],
      })),
    })),
  };
}

/**
 * 投影 → 供向量化的文本（TP-2-21）。
 *
 * **只接受 `RetrievalProjection`，不接受 `TravelPlanContent`。**
 * 这个签名就是 15.2「`plan_embedding` 必须由 `retrieval_projection` 计算」
 * 在类型层的落点：想拿 `plan_json` 算向量，得先改这个函数的签名，
 * 而那是一次显式的、会被 review 看到的改动。若签名收 `TravelPlanContent`，
 * 「顺手多拼一个字段」就够把金额与日期以向量形式残留进去了 ——
 * 而向量里的残留无法用肉眼检查，也不会有任何报错。
 *
 * 拼接顺序固定（目的地 → 天数 → 逐日主题 → POI → 美食 → 路线），
 * 因此同一份投影永远得到同一段文本，向量可复现。
 */
export function projectionToEmbeddingText(projection: RetrievalProjection): string {
  const lines: string[] = [
    `目的地：${projection.destination.name}`,
    `天数：${projection.total_days}`,
  ];

  projection.days.forEach((day, index) => {
    lines.push(`第 ${index + 1} 天主题：${day.theme}`);
    if (day.subtitle.length > 0) lines.push(`副题：${day.subtitle}`);

    for (const item of day.schedule) {
      lines.push(`行程：${item.title}｜${item.location.name}｜${item.period}`);
      if (item.description.length > 0) lines.push(`说明：${item.description}`);
    }
    for (const food of day.food_recommendations) {
      lines.push(`美食：${food.name}｜${food.entity_type}`);
    }
    for (const route of day.route_recommendations) {
      if (route.nodes.length > 0) lines.push(`路线：${route.nodes.join(' → ')}`);
    }
  });

  return lines.join('\n');
}

/**
 * 请求 → 查询向量用的文本（TP-2-23）。
 *
 * ## 为什么查询侧只有请求，没有主题
 *
 * 3.2.4 的检索发生在 `RETRIEVING_REFERENCES`，也就是**生成之前** ——
 * 那时还没有任何行程内容，唯一的信号就是用户的需求本身。这是设计使然，
 * 不是实现取巧。
 *
 * ## 为什么不把条件 code 拼进来
 *
 * `interest.history_culture` 这类 code 是英文标识符，而投影文本全是中文
 * （POI 名、主题）。拼进来产生的词与投影侧一个都对不上，只会在归一化时
 * 稀释真正有用的信号。用户在自由文本里写「想看运河」时，「运河」与投影里的
 * 「运河人文」「大运河博物馆」是**真实的词汇重合** —— 那才是 V1 的召回来源。
 *
 * 换成语义向量模型后，条件 code 可以先映射成中文描述再拼入，届时召回质量
 * 会显著提高；本函数的签名不变。
 */
export function normalizedRequestToEmbeddingText(normalized: NormalizedTravelRequest): string {
  const lines = [`目的地：${normalized.destination_name}`, `天数：${normalized.total_days}`];
  if (normalized.custom_text.length > 0) lines.push(`需求：${normalized.custom_text}`);
  return lines.join('\n');
}

/**
 * 读取历史投影时的校验。
 *
 * 库里的行可能是**投影规则修订之前**写入的，形状与当前 schema 不一致。
 * 跨用户读取前解析一遍：解析失败就当作「这条参考不可用」跳过，
 * 而不是把一份形状未知的 JSON 塞进 LLM 上下文。
 */
export function parseRetrievalProjection(value: unknown): RetrievalProjection | null {
  const parsed = RetrievalProjectionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
