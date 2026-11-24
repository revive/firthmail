/** 巨型内联图片会让 WebView2 渲染器直接压死成白屏：引擎把邮件里的 CID
 * 图变成 data URI，单张可到 8 MB，一封邮件可带 32 张。实测量级：收件箱
 * 里有 18 MB 与 179 MB 的邮件。防线有两条：单张超过约 300 KB 换占位图；
 * 放行的内联图总量超过约 2 MB 后，后面的也全部换占位图。 */

/** 1x1 透明 GIF。 */
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const DATA_URI_SRC = /src="(data:([^;,"']+);base64,([A-Za-z0-9+/=]+))"/g;

/** 每张内联图最多放行的 base64 字符数（约 300 KB 解码后）。 */
const MAX_INLINE_BASE64 = 400 * 1024;
/** 一封正文放行的内联图总预算（约 2 MB 解码后）。 */
const MAX_TOTAL_BASE64 = 2.6 * 1024 * 1024;

export function sanitizeMailHtml(html: string): string {
  let spent = 0;
  return html.replace(DATA_URI_SRC, (match, _full: string, mime: string, b64: string) => {
    if (b64.length <= MAX_INLINE_BASE64 && spent + b64.length <= MAX_TOTAL_BASE64) {
      spent += b64.length;
      return match;
    }
    const kb = Math.round((b64.length * 3) / 4 / 1024);
    return `src="${PLACEHOLDER}" data-firthmail-skipped-image="${mime}" alt="[内联图片 ${kb} KB，为防卡顿已隐藏]" title="内联图片 ${kb} KB 已隐藏"`;
  });
}
