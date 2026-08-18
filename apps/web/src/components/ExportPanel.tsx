'use client';

import type { FullPlanViewModelShape } from '@tps/schemas';
import { useEffect, useRef, useState } from 'react';

import { createExport, getExport, type ExportResponse } from '@/lib/api-client';
import { buildExportRequest, type ExportChoice } from '@/lib/export-request';

/**
 * 导出入口（设计稿 13.5、13.6，验收标准 10）。
 *
 * ## 为什么这个组件必须存在
 *
 * 13.5/13.6 两个端点、`exports` 表、render-worker 的消费、7 天预签名与重签
 * 在 P4 就全部交付了 —— 但用户界面上没有任何入口。验收标准 10 是
 * 「HTML、PNG、PDF 至少两种输出可用」，而「端点可用」与「用户可用」之间
 * 差的正是这个组件。
 *
 * ## 三种导出，对应 13.5 的产物组织
 *
 * ```text
 * PDF  + FULL_PLAN   一个多页 PDF —— 打印整份行程
 * PNG  + SINGLE_DAY  一张长图 —— 分享某一天
 * PDF  + ALL_DAYS    每日信息图合并成一个 N 页 PDF
 * ```
 *
 * 不提供 `PNG + ALL_DAYS`（那会产出 14 个文件，用户要自己按文件名排序）——
 * 它在契约里合法，但作为界面选项只会制造困惑。需要单日 PNG 的人一次导一天。
 */

/** 13.6 的轮询间隔。导出是秒级任务（21.2：单页 PNG < 8 秒），2 秒足够 */
const POLL_MS = 2_000;

/**
 * 轮询上限。21.2 最慢的一档是 `ALL_DAYS` 的 14 页 PDF 合并（< 15 秒），
 * 加上排队与重试（`attempts: 2`）留到 120 秒。
 */
const POLL_TIMEOUT_MS = 120_000;

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working'; readonly progress: number; readonly label: string }
  | { readonly kind: 'done'; readonly result: ExportResponse; readonly partial: boolean }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean };

export function ExportPanel({
  planId,
  viewModel,
}: {
  readonly planId: string;
  readonly viewModel: FullPlanViewModelShape;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [day, setDay] = useState(1);
  const cancelled = useRef(false);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  /*
   * 天数从 ViewModel 取而不是另发一次请求：完整页的 `days` 就是可导出的天数
   * 集合。`Math.max(1, ...)` 是防御性的 —— 一份 days 为空的历史 ViewModel
   * 不该让下拉框变成空的（那时用户连「第 1 天」都选不了）。
   */
  const dayCount = Math.max(1, viewModel.days.length);
  const planVersionId = viewModel.plan_version_id;

  async function start(choice: ExportChoice): Promise<void> {
    const { body, label } = buildExportRequest(choice, planVersionId);
    setPhase({ kind: 'working', progress: 0, label });

    const created = await createExport(planId, body);
    if (cancelled.current) return;

    if (!created.ok) {
      /*
       * 21.4 的每计划导出次数上限（匿名 3 次、注册 10 次）会在这里以
       * `AUTH_QUOTA_EXCEEDED` 出现。把服务端的文案原样显示 ——
       * 它已经写清楚了「注册可以有更多次数」，而前端自己编一句会与政策不一致。
       */
      setPhase({ kind: 'error', message: created.message, retryable: created.retryable });
      return;
    }

    const startedAt = Date.now();

    const poll = async (exportId: string): Promise<void> => {
      if (cancelled.current) return;

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setPhase({
          kind: 'error',
          message: '导出用时超出预期。稍后回到本页可以再试一次。',
          retryable: true,
        });
        return;
      }

      const result = await getExport(exportId);
      if (cancelled.current) return;

      if (!result.ok) {
        setPhase({ kind: 'error', message: result.message, retryable: result.retryable });
        return;
      }

      const { status, progress } = result.data;
      if (status === 'COMPLETED' || status === 'PARTIAL') {
        /*
         * `PARTIAL` 也是可交付的终态（13.6）：12 页的行程比零页有用，
         * 而下面的提示会如实说明缺了哪几天 —— 悄悄当成成功才是不能做的事。
         */
        setPhase({ kind: 'done', result: result.data, partial: status === 'PARTIAL' });
        return;
      }
      if (status === 'FAILED') {
        setPhase({
          kind: 'error',
          message: result.data.error?.message ?? '导出失败，请稍后重试。',
          retryable: true,
        });
        return;
      }

      setPhase({ kind: 'working', progress, label });
      setTimeout(() => void poll(exportId), POLL_MS);
    };

    // 13.5 返回 201 + QUEUED（或幂等命中时返回既有任务），随即开始轮询
    setPhase({ kind: 'working', progress: created.data.progress, label });
    setTimeout(() => void poll(created.data.export_id), POLL_MS);
  }

  const busy = phase.kind === 'working';

  return (
    <section className="export-panel" aria-label="导出">
      <h2 className="export-panel__title">导出</h2>

      <div className="export-panel__actions">
        <button type="button" disabled={busy} onClick={() => void start({ kind: 'full-pdf' })}>
          完整行程 PDF
        </button>
        <button type="button" disabled={busy} onClick={() => void start({ kind: 'all-days-pdf' })}>
          每日信息图 PDF
        </button>

        <span className="export-panel__day">
          <label htmlFor="export-day">单日长图</label>
          <select
            id="export-day"
            value={day}
            disabled={busy}
            onChange={(event) => setDay(Number(event.target.value))}
          >
            {Array.from({ length: dayCount }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>
                第 {value} 天
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => void start({ kind: 'single-day-png', dayNumber: day })}
          >
            导出 PNG
          </button>
        </span>
      </div>

      {phase.kind === 'working' ? (
        <p className="export-panel__status" role="status">
          正在生成{phase.label}…（{phase.progress}%）
        </p>
      ) : null}

      {phase.kind === 'error' ? (
        <p className="export-panel__error" role="alert">
          {phase.message}
          {phase.retryable ? '' : '（这次请求不会自动重试）'}
        </p>
      ) : null}

      {phase.kind === 'done' ? (
        <div className="export-panel__result">
          {phase.partial ? (
            <p role="status">部分页面导出失败，以下是已生成的产物。</p>
          ) : (
            <p role="status">导出完成。</p>
          )}
          <ul>
            {phase.result.files.map((file) => (
              <li key={file.url}>
                {/*
                 * `download` 属性让浏览器直接下载而不是在标签页里打开 PDF。
                 * 不加 `target="_blank"`：预签名 URL 带签名参数，
                 * 在新标签页里它会出现在地址栏与浏览历史里。
                 */}
                <a href={file.url} download>
                  {file.day_number === null
                    ? `${file.format} 文件`
                    : `第 ${String(file.day_number)} 天 ${file.format}`}
                </a>
                <span className="export-panel__size"> {Math.round(file.byte_size / 1024)} KB</span>
              </li>
            ))}
          </ul>
          {/*
           * 7 天有效期必须写出来（13.6）。不说的话用户会把链接存进收藏夹，
           * 一周后打开得到一个 403 —— 而那时他会以为是我们把文件删了。
           */}
          <p className="export-panel__hint">下载链接 7 天内有效，过期后回到本页可重新获取。</p>
        </div>
      ) : null}
    </section>
  );
}
