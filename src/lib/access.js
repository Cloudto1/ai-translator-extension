/**
 * 后台消息的调用方鉴权（纯逻辑，不依赖 chrome.*，可在 Node 中直接测试）。
 *
 * 内容脚本跑在网页里，是整个扩展中暴露面最大的一环：一旦它被页面里的漏洞或
 * 恶意脚本间接操控，就会拿到和 popup 同等的后台权限——读出 API Key、改写设置，
 * 甚至用 TEST_CONNECTION 把 Key 连同自定义 baseUrl 一起发往攻击者的服务器。
 * 所以敏感操作只认扩展自己的页面（popup / 管理面板）。
 */

import { MSG } from './protocol.js';

/** 只有扩展页面才能发起的操作：改配置、测连接、清缓存、远程驱动标签页。 */
export const PRIVILEGED_MESSAGES = Object.freeze(
  new Set([
    MSG.SAVE_SETTINGS,
    MSG.RESET_SETTINGS,
    MSG.TEST_CONNECTION,
    MSG.RUN_ON_TAB,
    MSG.GET_CACHE_STATS,
    MSG.CLEAR_CACHE,
  ]),
);

/** popup 可以经由后台下发给标签页的命令（白名单，不透传任意类型）。 */
export const TAB_COMMANDS = Object.freeze(
  new Set([
    MSG.RUN_TRANSLATE_PAGE,
    MSG.RUN_SUMMARIZE_PAGE,
    MSG.RUN_TRANSLATE_SELECTION,
    MSG.CMD_TRANSLATE_PAGE,
    MSG.CMD_SUMMARIZE_PAGE,
    MSG.CMD_TRANSLATE_SELECTION,
  ]),
);

/**
 * 消息是否来自扩展自己的页面，而不是注入网页的内容脚本。
 * 内容脚本的 sender.url 是它所在网页的地址，永远不会以扩展源开头。
 * @param {{id?:string, url?:string}} sender chrome.runtime.MessageSender
 * @param {{id:string, origin:string}} self 本扩展的 id 与源（形如 chrome-extension://<id>/）
 */
export function isExtensionSender(sender, self) {
  if (!sender || !self?.id || !self?.origin) return false;
  return sender.id === self.id && String(sender.url || '').startsWith(self.origin);
}

export function isPrivilegedMessage(type) {
  return PRIVILEGED_MESSAGES.has(type);
}

export function isAllowedTabCommand(command) {
  return TAB_COMMANDS.has(command);
}

/** 内容脚本拿到的设置不含 API Key：页面里的代码根本不需要它，请求都由后台代发。 */
export function settingsForContent(settings) {
  return { ...settings, apiKey: '' };
}
