import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { FontFaces } from '@/components/FontFaces';
import './globals.css';
/*
 * P8：采集界面的样式。放在 globals.css **之后** —— 它的选择器全部挂在
 * `.planner` 之下，因此不会覆盖 globals 的任何规则；顺序只影响可读性。
 */
import './planner.css';

export const metadata: Metadata = {
  title: '旅行计划信息图',
  description: '自动生成可浏览的旅行计划、每日信息图、PNG 长图与 PDF',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  // lang 固定 zh-CN（设计稿 1.1 输出语言）
  return (
    <html lang="zh-CN">
      <head>
        <FontFaces />
      </head>
      <body>{children}</body>
    </html>
  );
}
