/**
 * R-14 / 设计稿 22.3.3：禁止在字符串字面量中硬编码 Windows 路径分隔符。
 *
 * 背景：开发在 Windows、运行在 Linux。`'src\\foo.ts'` 或 `dir + '\\' + name`
 * 在 Windows 上可用，在 Linux 上会被当作文件名的一部分而静默产生错误路径 ——
 * 不报错、不崩溃，只是找不到文件或写到奇怪的位置。
 *
 * 规则只针对"看起来是路径"的字面量，避免误报正则、转义序列与文本内容：
 *   - 报告：'a\\b'、'.\\dist'、'C:\\Users'、'\\'（单独用作分隔符）
 *   - 放过：'\\n'、'\\t'、'\\\\d+'（正则字符类）、'\\u4e2d' 等转义
 *
 * 正确写法：node:path 的 join/resolve；URL 与对象存储键一律用 '/'。
 */

/** 转义序列白名单：这些反斜杠不是路径分隔符 */
const ESCAPE_AFTER = new Set([
  'n',
  'r',
  't',
  'b',
  'f',
  'v',
  '0',
  'u',
  'x',
  's',
  'd',
  'w',
  'S',
  'D',
  'W',
  'p',
  'P',
  'k',
  'b',
]);

/**
 * 判断字符串的原始文本是否含有被当作路径分隔符使用的反斜杠。
 * @param {string} raw 字面量的原始文本（含引号）
 */
function hasPathSeparator(raw) {
  // 逐字符扫描原始文本，寻找 \\ （源码里的两个字符）后面跟路径字符的情况
  for (let i = 0; i < raw.length - 1; i += 1) {
    if (raw[i] !== '\\') continue;

    const next = raw[i + 1];

    // 源码中的 \\ 表示一个真实反斜杠字符
    if (next === '\\') {
      const after = raw[i + 2];
      // 真实反斜杠后跟字母/数字/点/下划线/引号结尾 → 判定为路径分隔符
      if (after === undefined || /[A-Za-z0-9._\-'"`/]/.test(after)) {
        return true;
      }
      i += 2;
      continue;
    }

    // 单个 \ 后跟已知转义字符 → 是转义序列，跳过
    if (ESCAPE_AFTER.has(next)) {
      i += 1;
      continue;
    }
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '禁止硬编码 Windows 路径分隔符；使用 node:path，URL 与对象存储键用正斜杠（设计稿 22.3.3）',
    },
    schema: [],
    messages: {
      windowsSeparator:
        '检测到硬编码的 Windows 路径分隔符 "\\"。运行平台为 Linux（设计稿 22.3），请改用 node:path 的 join/resolve；URL 与对象存储键一律使用 "/"。',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const raw = sourceCode.getText(node);
        if (hasPathSeparator(raw)) {
          context.report({ node, messageId: 'windowsSeparator' });
        }
      },

      TemplateElement(node) {
        const raw = node.value.raw;
        if (hasPathSeparator(raw)) {
          context.report({ node, messageId: 'windowsSeparator' });
        }
      },
    };
  },
};

export default rule;
