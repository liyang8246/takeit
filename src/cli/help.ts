export const HELP = `takeit · 只操作扩展明确授权的那个标签页

用法：npx -y @liyang8246/takeit <token> <command> [参数] [选项]

  state [--with-id] [--with-class] [--with-hidden]  读取 DOM 快照
  click <uid>                                  点击元素
  type <uid> <text> [--submit]                   替换输入内容，可按 Enter 提交
  key <key>                                    Enter/Tab/Escape/Backspace/Delete/Arrow方向键
  scroll <dy>                                  垂直滚动像素，可为负数
  navigate <http/https URL>                     在同一标签页导航
  wait <ms>                                    等待 0–10000 毫秒
  script <JavaScript>                          在页面主世界执行，提供 jQuery
  screenshot <new.png> [--full]                 保存视口/整页 PNG，不覆盖已有文件
  help                                         本地显示说明，不连接扩展

所有页面命令支持 --timeout <秒>（默认 30，最大 300，包含等待端口时间）。
文本/代码以 -- 开头时，在其前加独立的 --，并且后面不再添加选项。
快照 uid 用于 click/type；页面导航或节点替换后应重新读取 state。
输出可能很长，建议重定向文件后按需读取；操作仅返回 ok，需要时自己读取 state。
每条命令临时绑定 127.0.0.1:8737，完成即退出，没有后台服务。
端口忙时限时等待；只保证逐条互斥，不保证 FIFO 或多 agent 整个任务独占。
切换/停止接管后，旧 token 立即失效；本机其他程序占端口时也会等待。
命令已送达后发生超时/中断，执行结果未知；先检查页面，不要自动重试副作用。
下单、发消息、删除等不可逆操作，先征求用户确认。
`
