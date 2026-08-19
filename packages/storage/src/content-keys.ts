import { uuidv7Date } from '@tps/shared';

/**
 * 15.4 产物对象存储路径约定（TP-6-11，设计稿 15.4 / R-49）。
 *
 * ```text
 * 注册用户：users/{user_id}/{yyyyMM}/{content_id}/exports/{export_id}/{file}
 * 匿名用户：anon/{yyyyMM}/{content_id}/exports/{export_id}/{file}
 * ```
 *
 * ## 适用范围只有导出产物
 *
 * 15.4 的表格：素材走 `assets/{role}/{ab}/{id}.webp`（全局共享，与用户空间
 * 正交）、ViewModel 落 `plan_presentations` 表、HTML 不落盘（R-35）。
 * 只有 PNG/PDF 按用户空间归档。
 *
 * ## 匿名走通用空间 `anon/`，不建每人目录
 *
 * 15.4：匿名身份基数大（含清 Cookie 反复创建的）且 30 天即清，
 * 逐人前缀只会制造千万级近空目录。索引与归属由数据库行保留
 * （`exports.user_id`），对象定位靠 `content_id`。
 *
 * **通用空间只是存储组织方式，不是可见性边界。** 对外访问一律经 13.6 的
 * 预签名签发，签发前按 13.0 校验 `user_id` —— 匿名 A 拿不到匿名 B 的签名，
 * 与注册用户隔离强度相同。路径里有没有 `user_id` 与谁能访问无关：
 * 导出桶本就不可公开读。
 *
 * ## `yyyyMM` 从 `content_id` 派生，不引入第二个时间来源
 *
 * 15.4 的原话。这样不存在「行的 `created_at` 与键里的年月对不上」这类漂移。
 *
 * **一处对设计稿的偏离（R-53）**：`content_id` 不是 UUIDv7 时回退到
 * `contentCreatedAt`。开发库与 CI 里存在 P2～P5 期间产生的 v4 版本行，
 * 对它们 `uuidv7Date` 返回 `null` —— 硬失败会让 `pnpm test:e2e` 从此变红，
 * 而那些行的产物仍然需要一个可推导的键（否则 retention 的对象清理与
 * `content:find` 的前缀展示都对它们无从下手）。
 *
 * 回退分支只对旧行生效：有一条单测断言「v7 的 ID 完全忽略
 * `contentCreatedAt`」，因此新数据不存在第二个时间来源。
 */

export interface ContentSpace {
  readonly userType: 'ANONYMOUS' | 'REGISTERED';
  readonly userId: string;
  /** = `plan_version_id`（UUIDv7，R-48） */
  readonly contentId: string;
  /**
   * 仅当 `contentId` 不是 UUIDv7 时用于推导 `yyyyMM`（R-53）。
   *
   * 传的应当是该内容行的 `created_at`。v7 的 ID 会**完全忽略**这个值。
   */
  readonly contentCreatedAt: Date;
}

/** UTC 的 `yyyyMM`。取 UTC 是 15.4 的明文要求 —— 本地时区会让同一个 ID 在不同部署得到不同路径 */
function yearMonth(at: Date): string {
  return at.toISOString().slice(0, 7).replace('-', '');
}

/**
 * 内容的对象存储前缀，**以 `/` 结尾**。
 *
 * 结尾带 `/` 是有意的：调用方拼接时不需要记得加，而漏加会得到
 * `.../{content_id}exports/...` 这种既不报错也不正确的键。
 */
export function contentPrefix(space: ContentSpace): string {
  const encoded = uuidv7Date(space.contentId);
  const month = yearMonth(encoded ?? space.contentCreatedAt);

  return space.userType === 'ANONYMOUS'
    ? `anon/${month}/${space.contentId}/`
    : `users/${space.userId}/${month}/${space.contentId}/`;
}

/** 15.4 的完整导出产物键 */
export function exportObjectKeyFor(
  space: ContentSpace,
  exportId: string,
  fileName: string,
): string {
  return `${contentPrefix(space)}exports/${exportId}/${fileName}`;
}
