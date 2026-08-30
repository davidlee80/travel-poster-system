'use client';

import type { FullPlanViewModelShape } from '@tps/schemas';
import { useEffect, useRef, useState } from 'react';

import { createExport, getExport, listExports, type ExportResponse } from '@/lib/api-client';
import { buildExportRequest, type ExportChoice } from '@/lib/export-request';

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;

type Phase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'working';
      readonly exportId: string;
      readonly progress: number;
      readonly label: string;
    }
  | { readonly kind: 'done'; readonly result: ExportResponse; readonly partial: boolean }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean };

function labelFor(result: ExportResponse): string {
  if (result.scope === 'FULL_PLAN') {
    return result.format === 'PDF' ? '完整攻略 PDF' : '完整攻略长图';
  }
  if (result.scope === 'ALL_DAYS') {
    return result.format === 'PDF' ? '每日攻略合集 PDF' : '全部每日攻略 PNG';
  }
  const day =
    result.day_numbers?.[0] ?? result.files.find((file) => file.day_number !== null)?.day_number;
  return `第 ${String(day ?? '')} 天 ${result.format}`.trim();
}

function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function statusText(status: ExportResponse['status']): string {
  return {
    QUEUED: '等待导出',
    RENDERING: '正在渲染',
    COMPLETED: '已完成',
    PARTIAL: '部分完成',
    FAILED: '导出失败',
  }[status];
}

/** 用户可见的导出、任务恢复和下载入口。 */
export function ExportPanel({
  planId,
  viewModel,
}: {
  readonly planId: string;
  readonly viewModel: FullPlanViewModelShape;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [history, setHistory] = useState<readonly ExportResponse[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [day, setDay] = useState(1);
  const cancelled = useRef(false);

  const dayCount = Math.max(1, viewModel.days.length);
  const planVersionId = viewModel.plan_version_id;

  function upsertHistory(result: ExportResponse): void {
    setHistory((current) => [
      result,
      ...current.filter((item) => item.export_id !== result.export_id),
    ]);
  }

  async function poll(exportId: string, label: string, startedAt = Date.now()): Promise<void> {
    if (cancelled.current) return;
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      setPhase({
        kind: 'error',
        message: '导出仍在后台处理中。稍后刷新本页可继续查看进度。',
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

    upsertHistory(result.data);
    if (result.data.status === 'COMPLETED' || result.data.status === 'PARTIAL') {
      setPhase({
        kind: 'done',
        result: result.data,
        partial: result.data.status === 'PARTIAL',
      });
      return;
    }
    if (result.data.status === 'FAILED') {
      setPhase({
        kind: 'error',
        message: result.data.error?.message ?? '导出失败，请稍后重试。',
        retryable: true,
      });
      return;
    }

    setPhase({
      kind: 'working',
      exportId,
      progress: result.data.progress,
      label,
    });
    setTimeout(() => void poll(exportId, label, startedAt), POLL_MS);
  }

  useEffect(() => {
    cancelled.current = false;

    void (async () => {
      const result = await listExports(planId);
      if (cancelled.current) return;
      setHistoryLoading(false);
      if (!result.ok) {
        setDownloadError(result.message);
        return;
      }

      setHistory(result.data.items);
      const active = result.data.items.find(
        (item) =>
          item.plan_version_id === planVersionId &&
          item.template_id === viewModel.template_id &&
          (item.status === 'QUEUED' || item.status === 'RENDERING'),
      );
      if (active !== undefined) {
        const label = labelFor(active);
        setPhase({
          kind: 'working',
          exportId: active.export_id,
          progress: active.progress,
          label,
        });
        setTimeout(() => void poll(active.export_id, label), POLL_MS);
      }
    })();

    return () => {
      cancelled.current = true;
    };
    // 计划或版本变化时重新恢复导出任务；模板 ID 包含在 ViewModel 版本中。
  }, [planId, planVersionId]);

  async function start(choice: ExportChoice): Promise<void> {
    const { body, label } = buildExportRequest(choice, planVersionId, viewModel.template_id);
    setDownloadError(null);
    setPhase({ kind: 'working', exportId: '', progress: 0, label });

    const created = await createExport(planId, body);
    if (cancelled.current) return;
    if (!created.ok) {
      setPhase({ kind: 'error', message: created.message, retryable: created.retryable });
      return;
    }

    setPhase({
      kind: 'working',
      exportId: created.data.export_id,
      progress: 0,
      label,
    });
    setTimeout(() => void poll(created.data.export_id, label), POLL_MS);
  }

  /** 下载前重新 GET，确保链接和 Content-Disposition 都是新签名。 */
  async function download(exportId: string, fileName: string): Promise<void> {
    setDownloadError(null);
    setDownloading(`${exportId}:${fileName}`);
    const fresh = await getExport(exportId);
    if (cancelled.current) return;
    setDownloading(null);

    if (!fresh.ok) {
      setDownloadError(fresh.message);
      return;
    }
    upsertHistory(fresh.data);
    const file = fresh.data.files.find((item) => item.file_name === fileName);
    if (file === undefined) {
      setDownloadError('文件已经更新，请刷新导出列表后重试。');
      return;
    }
    window.location.assign(file.url);
  }

  const busy = phase.kind === 'working';

  return (
    <section id="downloads" className="export-panel" aria-label="下载攻略">
      <div className="export-panel__heading">
        <div>
          <p className="export-panel__eyebrow">保存到设备</p>
          <h2 className="export-panel__title">下载攻略</h2>
        </div>
        <p className="export-panel__intro">下载文件固定为当前看到的攻略版本。</p>
      </div>

      <div className="export-panel__groups">
        <div className="export-panel__group">
          <h3>完整攻略</h3>
          <div className="export-panel__actions">
            <button
              type="button"
              className="export-panel__primary"
              disabled={busy}
              onClick={() => void start({ kind: 'full-pdf' })}
            >
              完整攻略 PDF
            </button>
            <button type="button" disabled={busy} onClick={() => void start({ kind: 'full-png' })}>
              完整攻略长图
            </button>
          </div>
        </div>

        <div className="export-panel__group">
          <h3>每日攻略合集</h3>
          <div className="export-panel__actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void start({ kind: 'all-days-pdf' })}
            >
              合集 PDF
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void start({ kind: 'all-days-png' })}
            >
              全部 PNG（含 ZIP）
            </button>
          </div>
        </div>

        <div className="export-panel__group">
          <h3>单日攻略</h3>
          <div className="export-panel__day">
            <label htmlFor="export-day">选择日期</label>
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
              PNG
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void start({ kind: 'single-day-pdf', dayNumber: day })}
            >
              PDF
            </button>
          </div>
        </div>
      </div>

      {phase.kind === 'working' ? (
        <div className="export-panel__working" role="status" aria-live="polite">
          <span>正在生成{phase.label}…</span>
          <progress value={phase.progress} max={100} aria-label="导出进度" />
          <strong>{phase.progress}%</strong>
        </div>
      ) : null}

      {phase.kind === 'error' ? (
        <p className="export-panel__error" role="alert">
          {phase.message}
          {phase.retryable ? '' : '（请修改选择后重试）'}
        </p>
      ) : null}

      {phase.kind === 'done' ? (
        <p className="export-panel__done" role="status" aria-live="polite">
          {phase.partial ? '部分页面导出失败，可先下载以下成功文件。' : '导出完成，可以下载。'}
        </p>
      ) : null}

      {downloadError === null ? null : (
        <p className="export-panel__error" role="alert">
          {downloadError}
        </p>
      )}

      <div className="export-panel__history">
        <h3>导出记录</h3>
        {historyLoading ? <p role="status">正在读取导出记录…</p> : null}
        {!historyLoading && history.length === 0 ? <p>还没有导出记录。</p> : null}
        <ul>
          {history.map((item) => (
            <li key={item.export_id} className="export-panel__history-item">
              <div className="export-panel__history-title">
                <strong>{labelFor(item)}</strong>
                <span>{statusText(item.status)}</span>
              </div>
              {item.plan_version_id === planVersionId ? null : (
                <p className="export-panel__old-version">这是较早版本的下载文件。</p>
              )}
              {item.files.length === 0 ? null : (
                <ul className="export-panel__files">
                  {[...item.files]
                    .sort((a, b) => Number(b.format === 'ZIP') - Number(a.format === 'ZIP'))
                    .map((file) => {
                      const downloadKey = `${item.export_id}:${file.file_name}`;
                      return (
                        <li key={file.file_name}>
                          <button
                            type="button"
                            disabled={downloading === downloadKey}
                            onClick={() => void download(item.export_id, file.file_name)}
                          >
                            {downloading === downloadKey ? '准备下载…' : file.file_name}
                          </button>
                          <span>{sizeText(file.byte_size)}</span>
                        </li>
                      );
                    })}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <p className="export-panel__hint">
          下载时会自动获取新的临时链接；链接过期不会重新生成文件。
        </p>
      </div>
    </section>
  );
}
