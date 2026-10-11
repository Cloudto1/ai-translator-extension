/**
 * 消息与端口协议常量（background / content / popup 共用）。
 */

export const MSG = Object.freeze({
  GET_SETTINGS: 'GET_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  TEST_CONNECTION: 'TEST_CONNECTION',
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  // 内容脚本 -> 后台（一次性）
  CMD_TRANSLATE_PAGE: 'CMD_TRANSLATE_PAGE',
  CMD_SUMMARIZE_PAGE: 'CMD_SUMMARIZE_PAGE',
  CMD_TRANSLATE_SELECTION: 'CMD_TRANSLATE_SELECTION',
  STATE_CHANGED: 'STATE_CHANGED',
  // popup -> 当前标签页
  RUN_TRANSLATE_PAGE: 'RUN_TRANSLATE_PAGE',
  RUN_SUMMARIZE_PAGE: 'RUN_SUMMARIZE_PAGE',
  RUN_TRANSLATE_SELECTION: 'RUN_TRANSLATE_SELECTION',
  // popup -> background（由后台转发到标签页，必要时自动注入内容脚本）
  RUN_ON_TAB: 'RUN_ON_TAB',
  PING: 'PING',
  RESET_SETTINGS: 'RESET_SETTINGS',
});

export const PORT_NAME = 'ait-port';

/** 端口内请求类型 */
export const REQ = Object.freeze({
  TRANSLATE_TEXTS: 'TRANSLATE_TEXTS',
  TRANSLATE_ONE: 'TRANSLATE_ONE', // 流式
  SUMMARIZE: 'SUMMARIZE', // 流式
  ABORT: 'ABORT',
});

/** 端口内响应/事件类型 */
export const EVT = Object.freeze({
  RESULT: 'RESULT',
  DELTA: 'DELTA',
  DONE: 'DONE',
  ERROR: 'ERROR',
});
